const fallback = [0x78625d, 0xc4b9a9, 0xb8afa2, 0xd9d4c8];

export function surfaceGroup(height, verticalNormal, ceiling = 2.15) {
  if (Math.abs(verticalNormal) < .73) return 2;
  if (height <= .22) return 0;
  return height >= ceiling ? 3 : 1;
}

export function representativeShade(samples) {
  if (samples.length < 8) return null;
  const luminance = ([r, g, b]) => .2126 * r + .7152 * g + .0722 * b;
  const ordered = [...samples].sort((a, b) => luminance(a) - luminance(b));
  const trim = Math.floor(ordered.length * .15);
  const center = ordered.slice(trim, ordered.length - trim);
  return [0, 1, 2].map(channel => {
    const values = center.map(rgb => rgb[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] / 255;
  });
}

function sampleShades(THREE, mesh, bounds, ceiling) {
  const samples = fallback.map(() => []);
  const pixels = new Map();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d", {willReadFrequently: true});
  if (!context) return samples;
  function texturePixels(map) {
    if (!pixels.has(map)) {
      let data = null;
      try {
        context.clearRect(0, 0, 256, 256);
        context.drawImage(map.image, 0, 0, 256, 256);
        data = context.getImageData(0, 0, 256, 256).data;
        map.updateMatrix();
      } catch { /* A missing or unreadable texture uses the fallback shade. */ }
      pixels.set(map, data);
    }
    return pixels.get(map);
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const texel = new THREE.Vector2(), centroid = new THREE.Vector3();
  mesh.traverse(object => {
    if (!object.isMesh) return;
    const {geometry, material} = object;
    const {position, uv} = geometry.attributes;
    if (!position || !uv) return;
    const index = geometry.index;
    const count = index?.count ?? position.count;
    const groups = Array.isArray(material) ? geometry.groups : [{start: 0, count, materialIndex: 0}];
    for (const group of groups) {
      const map = [material].flat()[group.materialIndex]?.map;
      const data = map && texturePixels(map);
      if (!data) continue;
      const stride = 3 * Math.max(1, Math.floor(group.count / 3 / (6000 * group.count / count + 1)));
      for (let i = group.start; i + 2 < Math.min(count, group.start + group.count); i += stride) {
        const vertices = [i, i + 1, i + 2].map(j => index ? index.getX(j) : j);
        for (const [point, j] of [a, b, c].map((point, j) => [point, vertices[j]]))
          point.fromBufferAttribute(position, j).applyMatrix4(object.matrixWorld);
        const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize();
        centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        if (!bounds.containsPoint(centroid)) continue;
        const groupId = surfaceGroup(centroid.y, normal.y, ceiling);
        const mean = accessor => vertices.reduce((sum, j) => sum + accessor.call(uv, j), 0) / 3;
        texel.set(mean(uv.getX), mean(uv.getY));
        map.transformUv(texel);
        const x = Math.min(255, Math.max(0, Math.floor(texel.x * 256)));
        const y = Math.min(255, Math.max(0, Math.floor(texel.y * 256)));
        const offset = (y * 256 + x) * 4;
        if (data[offset + 3] > 127) samples[groupId].push([data[offset], data[offset + 1], data[offset + 2]]);
      }
    }
  });
  return samples;
}

export function relightLevels(elevation) {
  const daylight = Math.min(1, Math.max(0, (elevation + 6) / 30));
  // Approximate clear-sky attenuation along the atmospheric path. The
  // surface-angle factor is applied separately by the material's lighting.
  const sineElevation = Math.sin(elevation * Math.PI / 180);
  const beam = elevation > 0 ? Math.exp(-.16 / Math.max(.03, sineElevation)) : 0;
  return {sky: .075 + 1.65 * daylight, beam};
}

// Limit the depth cut to the glazing immediately around a confirmed pane.
export const glazingDepth = Object.freeze({inside: .04, outside: .18});

export function activeApertures(profile, frame) {
  const windows = new Map(profile.windows.map(window => [window.id, window]));
  return frame.windows.flatMap(verdict => {
    const window = windows.get(verdict.id);
    return window && ["clear-in-coverage", "exterior-unknown"].includes(verdict.status)
      ? [{window, verdict}] : [];
  });
}

const apertureShader = `
varying vec3 relightPosition;
uniform vec3 sunlightDirection;
uniform int apertureCount, confirmedPaneCount;
uniform vec3 apertureCorners[128], apertureNormals[32];

bool inOpening(vec3 point, int i) {
  bool positive = true;
  bool negative = true;
  for (int edge = 0; edge < 4; ++edge) {
    vec3 a = apertureCorners[i * 4 + edge];
    vec3 b = apertureCorners[i * 4 + (edge + 1) % 4];
    float side = dot(cross(b - a, point - a), apertureNormals[i]);
    positive = positive && side >= -0.0001;
    negative = negative && side <= 0.0001;
  }
  return positive || negative;
}
`;

export function createRelight(THREE, mesh, fill, scene, renderer, marks, room) {
  const originals = new Map();
  mesh.traverse(object => {
    if (object.isMesh) originals.set(object, {
      material: object.material, depth: object.customDepthMaterial,
      cast: object.castShadow, receive: object.receiveShadow,
    });
  });
  const originalIntensity = fill.intensity;
  const shadowEnabled = renderer.shadowMap.enabled;
  const sun = new THREE.DirectionalLight(0xffeed8, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -.00012;
  sun.shadow.normalBias = .018;
  sun.shadow.autoUpdate = false;
  const bounds = new THREE.Box3();
  const ceiling = Number.isFinite(room?.height) && room.height > 0 ? room.height : 3;
  if (room?.outline?.length >= 3) {
    for (const [x, z] of room.outline) {
      bounds.expandByPoint(new THREE.Vector3(x, 0, z));
      bounds.expandByPoint(new THREE.Vector3(x, ceiling, z));
    }
    bounds.expandByScalar(.35);
  } else bounds.setFromObject(mesh);
  const ceilingThreshold = ceiling * (2.15 / 3);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2) + .5;
  const shadowCamera = sun.shadow.camera;
  Object.assign(shadowCamera, {left: -radius, right: radius,
    top: radius, bottom: -radius, near: .1, far: radius * 4});
  shadowCamera.updateProjectionMatrix();
  sun.target.position.copy(center);
  scene.add(sun, sun.target);

  const uniforms = {
    sunlightDirection: {value: new THREE.Vector3()},
    apertureCount: {value: 0},
    confirmedPaneCount: {value: 0},
    apertureCorners: {value: Array.from({length: 128}, () => new THREE.Vector3())},
    apertureNormals: {value: Array.from({length: 32}, () => new THREE.Vector3())},
  };
  function apertureProgram(shader) {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `varying vec3 relightPosition;\n` + shader.vertexShader.replace(
      "#include <begin_vertex>", "#include <begin_vertex>\nrelightPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = apertureShader + shader.fragmentShader;
  }

  function applyReceiver(shader) {
    apertureProgram(shader);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", `
#include <lights_fragment_end>
float apertureVisible = 0.0;
for (int i = 0; i < 32; ++i) {
  if (i >= apertureCount) break;
  vec3 n = apertureNormals[i];
  float incidence = dot(n, sunlightDirection);
  if (incidence <= 0.0001) continue;
  float distanceToWindow = dot(apertureCorners[i * 4] - relightPosition, n) / incidence;
  if (distanceToWindow > 0.0 && inOpening(relightPosition + sunlightDirection * distanceToWindow, i)) {
    apertureVisible = 1.0;
    break;
  }
}
reflectedLight.directDiffuse *= apertureVisible;
reflectedLight.directSpecular *= apertureVisible;
`);
  }

  const glassDepth = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide});
  glassDepth.shadowSide = THREE.DoubleSide;
  glassDepth.onBeforeCompile = shader => {
    apertureProgram(shader);
    shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>", `
#include <alphatest_fragment>
for (int i = 0; i < 32; ++i) {
  if (i >= apertureCount) break;
  vec3 n = apertureNormals[i];
  float separation = dot(relightPosition - apertureCorners[i * 4], n);
  if (separation >= -${glazingDepth.inside} && separation <= ${glazingDepth.outside} && inOpening(relightPosition - separation * n, i)) discard;
}
`);
  };

  const roomMaterials = new Map();
  const actorMaterials = new Map();
  const actorOriginals = new Map();

  function syncActors() {
    if (!enabled) return;
    marks.traverse(actor => {
      if (!actor.isMesh || actorOriginals.has(actor)) return;
      const original = actor.material;
      actorOriginals.set(actor, {material: original, cast: actor.castShadow, receive: actor.receiveShadow});
      if (!actorMaterials.has(original)) {
        const lit = original.clone();
        lit.onBeforeCompile = applyReceiver;
        actorMaterials.set(original, lit);
      }
      actor.material = actorMaterials.get(original);
      actor.castShadow = actor.receiveShadow = true;
    });
    if (sun.visible) sun.shadow.needsUpdate = true;
  }

  let enabled = false;
  let previousFrame;
  let previousProfile;
  function set(frame, profile) {
    if (frame === previousFrame && profile === previousProfile) return;
    previousFrame = frame;
    previousProfile = profile;
    const active = Boolean(frame);
    if (active && !roomMaterials.size) {
      const shades = sampleShades(THREE, mesh, bounds, ceilingThreshold).map((samples, i) => {
        const rgb = representativeShade(samples);
        const color = new THREE.Color(fallback[i]);
        return rgb ? color.lerp(new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace),
          Math.min(1, samples.length / 48)) : color;
      });
      function materialFor(original) {
        if (roomMaterials.has(original)) return roomMaterials.get(original);
        const material = new THREE.MeshStandardMaterial({roughness: .94, side: THREE.DoubleSide,
          map: original.map ?? null});
        material.onBeforeCompile = shader => {
          applyReceiver(shader);
          shader.uniforms.roomCeilingThreshold = {value: ceilingThreshold};
          ["floor", "raised", "wall", "ceiling"].forEach((key, i) => {
            shader.uniforms[key + "Shade"] = {value: shades[i]};
          });
          shader.fragmentShader = `
uniform vec3 floorShade, raisedShade, wallShade, ceilingShade;
uniform float roomCeilingThreshold;
` + shader.fragmentShader.replace("#include <map_fragment>", `
#include <map_fragment>
vec3 surfaceNormal = normalize(cross(dFdx(relightPosition), dFdy(relightPosition)));
vec3 roomShade = abs(surfaceNormal.y) < 0.73 ? wallShade :
  (relightPosition.y <= 0.22 ? floorShade : (relightPosition.y >= roomCeilingThreshold ? ceilingShade : raisedShade));
#ifdef USE_MAP
for (int i = 0; i < 32; ++i) {
  if (i >= confirmedPaneCount) break;
  vec3 normal = apertureNormals[i];
  float separation = dot(relightPosition - apertureCorners[i * 4], normal);
  if (separation >= -${glazingDepth.inside} && separation <= ${glazingDepth.outside} &&
      inOpening(relightPosition - separation * normal, i)) {
    roomShade = mix(roomShade, diffuseColor.rgb, 0.85);
    break;
  }
}
#endif
diffuseColor.rgb = roomShade;
`);
        };
        roomMaterials.set(original, material);
        return material;
      }
      for (const record of originals.values()) {
        const original = record.material;
        record.relit = Array.isArray(original) ? original.map(materialFor) : materialFor(original);
      }
    }
    if (active !== enabled) {
      for (const [object, original] of originals) {
        object.material = active ? original.relit : original.material;
        object.customDepthMaterial = active ? glassDepth : original.depth;
        object.castShadow = active || original.cast;
        object.receiveShadow = active || original.receive;
      }
      if (!active) {
        for (const [actor, original] of actorOriginals) {
          actor.material = original.material;
          actor.castShadow = original.cast;
          actor.receiveShadow = original.receive;
        }
        actorOriginals.clear();
      }
      enabled = active;
      renderer.shadowMap.enabled = active || shadowEnabled;
    }
    if (active) syncActors();
    const levels = active && relightLevels(frame.sun.elevation);
    fill.intensity = active ? levels.sky : originalIntensity;
    const apertures = active ? activeApertures(profile, frame).map(({window}) => window) : [];
    uniforms.apertureCount.value = apertures.length;
    const activeIDs = new Set(apertures.map(window => window.id));
    const confirmedPanes = active ? [...apertures, ...profile.windows.filter(window => !activeIDs.has(window.id))] : [];
    uniforms.confirmedPaneCount.value = confirmedPanes.length;
    confirmedPanes.forEach((window, i) => {
      window.corners.forEach((corner, j) => uniforms.apertureCorners.value[i * 4 + j].fromArray(corner));
      uniforms.apertureNormals.value[i].fromArray(window.outward);
    });
    sun.visible = apertures.length > 0;
    sun.intensity = apertures.length > 0 ? levels.beam * 3.5 : 0;
    if (sun.visible) {
      const direction = uniforms.sunlightDirection.value.fromArray(frame.sun.direction);
      sun.position.copy(center).addScaledVector(direction, radius * 2);
      sun.color.setHex(frame.sun.elevation < 12 ? 0xffc48b : 0xffeed8);
      sun.shadow.needsUpdate = true;
    }
  }
  sun.visible = false;
  return {set, syncActors, photoMaterial: object => originals.get(object)?.material ?? object.material, dispose() {
    set(null);
    scene.remove(sun, sun.target);
    sun.shadow.dispose();
    glassDepth.dispose();
    for (const material of roomMaterials.values()) material.dispose();
    for (const lit of actorMaterials.values()) lit.dispose();
  }};
}
