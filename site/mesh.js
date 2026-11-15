import {mountDaylight} from "./daylight.js?v=matterport-heading";
import {alignMesh, sightlineCheck} from "./sightlines.js?v=dolly-daylight";
import {actorCenter, actorMarks, checkCameraHeight, furnitureHeight, loadShot, maxActors, roomKey, shotSettings, standIn} from "./room-state.js?v=volume";
import {cameraMoveAxis, checkFraming, checkRigClearance, easedPathFraction, editorShotState, findSlide, interpretDirection, pathFromEndpoints, slideEndpoints, timeFractionAtPath, tracePath} from "./path.js?v=volume";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#render-status");
const transport = document.querySelector("#transport");
const sightline = document.querySelector("#sightline");
const sightlineActions = document.querySelector("#sightline-actions");
const timeline = document.querySelector("#timeline");
const lens = document.querySelector("#lens");
const sensor = document.querySelector("#sensor-width");
const height = document.querySelector("#camera-height");
const pathHeightValue = document.querySelector("#path-height-value");
const rig = document.querySelector("#rig-radius");
const duration = document.querySelector("#shot-duration");
const settings = () => ({
  durationSeconds: Number(duration.value),
  sensorWidthMm: Number(sensor.value), cameraHeight: Number(height.value), rigRadius: Number(rig.value),
});
const moveKind = document.querySelector("#move-kind");
const travel = document.querySelector("#travel");
const retry = document.querySelector("#retry-mesh");
const showMarks = document.querySelector("#show-marks");
const aimElevation = document.querySelector("#aim-elevation");
const aimSlider = document.querySelector("#aim-height-slider");
const alignment = document.querySelector("#alignment");
const alignmentView = document.querySelector("#alignment-view");
const alignmentStatus = document.querySelector("#alignment-status");
const checkScan = document.querySelector("#check-scan");
const visibilityControl = document.querySelector("#visibility-control");
const sightlineHelp = document.querySelector("#sightline-help");
const fitPlanning = document.querySelector("#fit-planning");
const keepMark = document.querySelector("#keep-mark");
const exportShot = document.querySelector("#export-shot");
const directionForm = document.querySelector("#direction");
const fit = document.querySelector("#fit");
const revision = document.querySelector("#revision");
const button = document.querySelector("#play");
let active;

export function planCurrentShot(request) {
  if (!active) throw Error("Open a room in the editor first.");
  return active.plan(request);
}

export function applyCurrentShot(setup) {
  if (!active) throw Error("Open a room in the editor first.");
  active.apply(setup);
}

export function currentShot() {
  return active?.snapshot();
}

export function closeMesh() {
  active?.dispose();
  active = undefined;
  alignment.hidden = true;
  alignmentStatus.textContent = "";
  viewport.hidden = transport.hidden = retry.hidden = directionForm.hidden = true;
  status.textContent = "";
  sightline.textContent = "";
  sightlineActions.hidden = true;
  fitPlanning.hidden = true;
  fitPlanning.open = false;
  visibilityControl.hidden = true;
  revision.textContent = "";
  document.querySelector("#clearance").textContent = "";
  document.querySelector("#ceiling").textContent = "";
  document.querySelector("#framing").textContent = "";
}

export async function openMesh(room, signal) {
  retry.hidden = true;
  status.textContent = "Checking for the captured mesh…";
  try {
    const base = "/matterpak/" + encodeURIComponent(room.modelId) + "/";
    const response = await fetch(base + "manifest.json", {signal});
    if (response.status === 404) {
      throw new Error("MatterPak is not imported");
    }
    if (!response.ok) throw new Error("Mesh manifest unavailable");
    const {obj, mtl} = await response.json();
    status.textContent = "Loading captured geometry and photo textures…";
    const [THREE, {OBJLoader}, {MTLLoader}] = await Promise.all([
      import("three"), import("three/addons/loaders/OBJLoader.js"),
      import("three/addons/loaders/MTLLoader.js"),
    ]);
    const url = path => base + path.split("/").map(encodeURIComponent).join("/");
    const manager = new THREE.LoadingManager();
    let finish, fail;
    const assetsReady = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    manager.onLoad = finish;
    manager.onError = path => fail(new Error("A mesh asset did not load: " + path));
    manager.itemStart("scene");
    const work = async () => {
      try {
        const loader = new OBJLoader(manager);
        if (mtl) {
          const materials = await new MTLLoader(manager).loadAsync(url(mtl));
          materials.preload();
          loader.setMaterials(materials);
        }
        return await loader.loadAsync(url(obj));
      } finally {
        manager.itemEnd("scene");
      }
    };
    const [mesh] = await Promise.all([work(), assetsReady]);
    const textures = new Set();
    mesh.traverse(object => {
      if (!object.isMesh) return;
      const captured = material => {
        if (material.map) {
          material.map.colorSpace = THREE.SRGBColorSpace;
          textures.add(material.map);
        }
        const result = new THREE.MeshBasicMaterial({
          map: material.map, color: material.map ? 0xffffff : material.color,
        });
        material.dispose();
        return result;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(captured) : captured(object.material);
    });
    const release = () => {
      for (const texture of textures) texture.dispose();
      mesh.traverse(object => {
        if (!object.isMesh) return;
        object.geometry.dispose();
        for (const material of [object.material].flat()) material.dispose();
      });
    };
    if (signal.aborted) {
      release();
      return;
    }
    try {
      active = mount(THREE, room, mesh, textures, release, true);
    } catch (error) {
      release();
      throw error;
    }
    status.textContent = "Captured MatterPak · photographed lighting";
  } catch (error) {
    if (!signal.aborted) {
      try {
        const THREE = await import("three");
        if (signal.aborted) return;
        const mesh = schematicRoom(THREE, room);
        active = mount(THREE, {...room, matterpakUp: "y", matterpakFloorHeight: 0},
          mesh, [], () => {
            for (const object of mesh.children) object.geometry.dispose();
            for (const material of new Set(mesh.children.map(object => object.material))) material.dispose();
          });
        status.textContent = "Scaled room outline · captured mesh unavailable";
        retry.hidden = false;
      } catch (fallbackError) {
        if (!signal.aborted) {
          status.textContent = "3D unavailable. Use the room plan below.";
          retry.hidden = false;
        }
        console.error(fallbackError);
      }
      console.info(error.message);
    }
  }
}

function schematicRoom(THREE, room) {
  const group = new THREE.Group();
  const shape = new THREE.Shape(room.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({color: 0x444d46, side: THREE.DoubleSide}));
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);
  const wall = new THREE.MeshBasicMaterial({color: 0x8f9b90, transparent: true, opacity: .72});
  const height = room.height || 3;
  room.outline.forEach(([x, z], index) => {
    const [nextX, nextZ] = room.outline[(index + 1) % room.outline.length];
    const object = new THREE.Mesh(new THREE.BoxGeometry(
      Math.hypot(nextX - x, nextZ - z), height, .035), wall);
    object.position.set((x + nextX) / 2, height / 2, (z + nextZ) / 2);
    object.rotation.y = -Math.atan2(nextZ - z, nextX - x);
    group.add(object);
  });
  return group;
}

function mount(THREE, room, mesh, textures, release, captured = false) {
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  for (const texture of textures) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202021);
  scene.add(mesh);
  alignMesh(mesh, room);

  const saved = {...loadShot(room), ...room.proposedShot};
  let curve = saved.moveKind === "curve"
    ? tracePath(room.proposedShot ? room.proposedShot.pathPoints : saved.pathPoints) : null;
  const actors = actorMarks(room, saved);
  const marks = new THREE.Group();
  const furniture = new THREE.Group();
  const furnitureMaterial = new THREE.MeshStandardMaterial({
    color: 0xb6644b, transparent: true, opacity: .68, roughness: .9,
  });
  scene.add(furniture);
  function clearFurniture() {
    for (const object of [...furniture.children]) {
      object.geometry.dispose();
      furniture.remove(object);
    }
  }
  function updateStandIns() {
    actors.forEach((point, index) => {
      if (index >= marks.children.length) {
        const figure = new THREE.Group();
        const material = new THREE.MeshStandardMaterial({
          color: standIn.colors[index % standIn.colors.length], roughness: .9,
        });
        const limb = (from, to, radius) => {
          const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
          const axis = end.clone().sub(start);
          const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, axis.length(), 6, 12), material);
          mesh.position.copy(start).lerp(end, .5);
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
          figure.add(mesh);
        };
        limb([0, .79, 0], [0, 1.23, 0], .105);
        limb([0, 1.27, 0], [0, 1.39, 0], .043);
        const head = new THREE.Mesh(new THREE.SphereGeometry(standIn.headRadius, 24, 16), material);
        head.position.y = standIn.eyeHeight;
        figure.add(head);
        for (const side of [-1, 1]) {
          const shoulder = [side * .105, 1.22, 0];
          const elbow = [side * .129, .98, .013];
          limb(shoulder, elbow, .036);
          limb(elbow, [side * .132, .755, .033], .032);
          const knee = [side * .068, .43, .021];
          limb([side * .065, .81, 0], knee, .059);
          limb(knee, [side * .081, .068, -.007], .045);
          limb([side * .081, .045, -.025], [side * .081, .045, .09], .044);
        }
        marks.add(figure);
      }
      const figure = marks.children[index];
      figure.visible = Boolean(point);
      if (point) [figure.position.x, figure.position.z] = point;
    });
    marks.children.slice(actors.length).forEach(child => { child.visible = false; });
  }
  updateStandIns();
  const fill = new THREE.HemisphereLight(0xffffff, 0xb7a28f, 2.3);
  scene.add(marks, fill);
  showMarks.checked = saved.showStandIns === true && actors.filter(Boolean).length >= 2;
  let aligned = captured && room.matterpakAlignmentVerified === true;
  checkScan.disabled = !aligned;
  checkScan.checked = false;

  const midpoint = room.outline.reduce(([x, z], [px, pz]) => [x + px, z + pz], [0, 0])
    .map(value => value / room.outline.length);
  let [cx, cz] = room.camera || midpoint;
  let aimLocked = saved.aimLocked === true;
  let [tx, tz] = saved.aim || room.lookAt || actorCenter(actors) || [midpoint[0], midpoint[1] - 1];

  const key = "scout-shot:" + roomKey(room);
  if (Array.isArray(saved?.mark) && saved.mark.length === 2 && saved.mark.every(Number.isFinite)) {
    [cx, cz] = saved.mark;
  }
  if (curve) [cx, cz] = curve.at(.5);
  const initialSettings = shotSettings(room, saved);
  let aimHeight = initialSettings.aimHeight;
  function syncAimHeight() {
    aimSlider.max = String(Math.max(4, Math.ceil(aimHeight)));
    aimSlider.value = String(aimHeight);
    aimElevation.value = aimHeight.toFixed(2);
  }
  syncAimHeight();
  let previewAim;
  const hasCast = () => actors.filter(Boolean).length >= 2;
  duration.value = initialSettings.durationSeconds;
  rig.value = initialSettings.rigRadius;
  sensor.value = initialSettings.sensorWidthMm;
  height.value = initialSettings.cameraHeight;
  pathHeightValue.value = initialSettings.cameraHeight.toFixed(2);
  lens.value = Number.isFinite(saved?.lens) ? saved.lens : 35;
  travel.value = Number.isFinite(saved?.travel) ? saved.travel : .7;
  keepMark.checked = saved?.keepMark !== false;
  checkScan.checked = saved?.requireSightlines === true;
  moveKind.value = curve ? "curve"
    : ["slide", "push", "pull", "static", "custom"].includes(saved?.moveKind) ? saved.moveKind : "slide";
  if (curve) travel.value = curve.travel;
  if (moveKind.value === "static") travel.value = "0";
  travel.disabled = Boolean(curve) || moveKind.value === "static";

  function save() {
    try {
      localStorage.setItem(key, JSON.stringify({
        mark: [cx, cz], ...settings(), aimHeight, lens: Number(lens.value), travel: curve?.travel ?? Number(travel.value), keepMark: keepMark.checked, moveKind: moveKind.value, axis: fixedMoveAxis, pathPoints: curve?.points, requireSightlines: checkScan.checked, showStandIns: showMarks.checked, actors, aimLocked, aim: [tx, tz],
      }));
    } catch {}
  }

  const camera = new THREE.PerspectiveCamera(35, 16 / 9, .03, 100);
  const overhead = new THREE.OrthographicCamera();
  const xs = room.outline.map(point => point[0]);
  const zs = room.outline.map(point => point[1]);
  const middleX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const middleZ = (Math.max(...zs) + Math.min(...zs)) / 2;
  const halfHeight = Math.max((Math.max(...xs) - Math.min(...xs)) / camera.aspect,
    Math.max(...zs) - Math.min(...zs)) * .65;
  overhead.left = -halfHeight * camera.aspect;
  overhead.right = -overhead.left;
  overhead.top = halfHeight;
  overhead.bottom = -halfHeight;
  overhead.position.set(middleX, 100, middleZ);
  overhead.up.set(0, 0, -1);
  overhead.lookAt(middleX, 0, middleZ);
  overhead.far = 400;
  overhead.updateProjectionMatrix();
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    room.outline.map(([x, z]) => new THREE.Vector3(x, 0, z))),
  new THREE.LineBasicMaterial({color: 0xffbf62, depthTest: false}));
  outline.renderOrder = 10;
  scene.add(outline);
  let reviewing = false;
  alignment.hidden = !captured;
  alignment.elements.height.value = room.matterpakFloorHeight || 0;
  alignment.elements.accepted.checked = aligned;
  alignmentView.setAttribute("aria-pressed", "false");

  const controls = new AbortController();
  let frame = 0;
  let start;
  let checkedTravel;
  let checkedLens;
  let sightlineTimer;
  let blockedView;
  let rayHeight;
  let raycast;
  function meshObstruction(from, to, cameraHeight = settings().cameraHeight, activeCurve) {
    if (!captured) return null;
    if (rayHeight !== cameraHeight) {
      raycast = sightlineCheck(THREE, mesh, actors, cameraHeight);
      rayHeight = cameraHeight;
    }
    return raycast(from, to, activeCurve?.at);
  }
  let obstacles = [];
  const plan = document.querySelector("#plan");

  viewport.querySelector("canvas")?.remove();
  viewport.prepend(renderer.domElement);
  viewport.hidden = transport.hidden = directionForm.hidden = false;
  timeline.value = "500";
  let playFromStart = true;

  let fixedMoveAxis = saved?.axis;

  function moveAxis() {
    return fixedMoveAxis || cameraMoveAxis(moveKind.value, [cx, cz], [tx, tz], room.slideAxis);
  }

  function endpoints(distance) {
    if (curve) return [curve.points[0], curve.points.at(-1)];
    const pose = editorShotState({
      mark: [cx, cz], axis: fixedMoveAxis, travel: distance, moveKind: moveKind.value,
      aim: [tx, tz], actors, lens: Number(lens.value), slideAxis: room.slideAxis,
    });
    return [pose.start, pose.end];
  }

  function framing(from, to, focal = Number(lens.value), cameraHeight = settings().cameraHeight, activeCurve) {
    if (!hasCast()) return null;
    const frameSettings = {
      focal, width: settings().sensorWidthMm, aspect: camera.aspect,
      cameraHeight, aimHeight,
    };
    const cast = actors.filter(Boolean);
    if (!activeCurve) return checkFraming(from, to, [tx, tz], cast, frameSettings);
    let worst = {margin: Infinity, limitingProgress: 0};
    for (const segment of activeCurve.segments) {
      const check = checkFraming(segment.from, segment.to, [tx, tz], cast, frameSettings);
      if (check.margin < worst.margin) worst = {margin: check.margin,
        limitingProgress: (segment.start + check.limitingProgress * segment.length) / activeCurve.travel};
    }
    return worst;
  }

  function clearance(from, to) {
    const check = (a, b) => checkRigClearance(room.outline, obstacles, a, b, settings().rigRadius);
    if (!curve) return check(from, to);
    let worst = {margin: Infinity};
    for (const segment of curve.segments) {
      const result = check(segment.from, segment.to);
      if (result.margin < worst.margin) worst = result;
    }
    return worst;
  }

  function inspectSightlines(from, to) {
    clearTimeout(sightlineTimer);
    blockedView = null;
    sightlineActions.hidden = true;
    if (!aligned || !hasCast()) {
      sightline.textContent = "";
      return;
    }
    sightline.textContent = "Checking actor visibility…";
    sightlineTimer = setTimeout(() => {
      const hit = meshObstruction(from, to, settings().cameraHeight, curve);
      blockedView = hit;
      sightlineActions.hidden = !hit;
      sightline.textContent = hit
        ? "The captured scan blocks the view of actor " + hit.actor + " near " + Math.round(hit.t * 100) + "% of the move."
        : "Actors are visible in the captured scan at all five checked positions.";
    }, 140);
  }

  function render() {
    const distance = Number(travel.value);
    const canFit = !curve && hasCast() && moveKind.value !== "static" && distance > 0;
    fitPlanning.hidden = !canFit;
    visibilityControl.hidden = false;
    checkScan.disabled = !aligned || !hasCast();
    const visibilityMessage = !captured ? "Load a captured scan to check actor visibility."
      : !aligned ? "Review scan alignment to enable this check."
      : !hasCast() ? "Place at least two actors to enable this check."
      : "When finding a fitting move, checks actor visibility at five points.";
    if (sightlineHelp.textContent !== visibilityMessage) sightlineHelp.textContent = visibilityMessage;
    const [from, to] = endpoints(distance);
    const t = Number(timeline.value) / 1000;
    const eased = easedPathFraction(t);
    const [x, z] = curve ? curve.at(eased) : from.map((value, index) => value + (to[index] - value) * eased);
    const focal = Number(lens.value);
    if (checkedTravel !== distance || checkedLens !== focal) {
      checkedTravel = distance;
      checkedLens = focal;
      const {margin, feature} = clearance(from, to);
      const scope = obstacles.length ? "Unmarked furniture unchecked." : "Furniture unchecked.";
      document.querySelector("#clearance").textContent = margin >= 0
        ? "At least " + Math.floor(margin * 100) + " cm beyond the rig radius at " + feature +
          ". " + scope
        : "Rig clearance fails at " + feature + ".";
      const ceiling = checkCameraHeight(room, settings().cameraHeight);
      document.querySelector("#ceiling").textContent = ceiling.status === "unknown"
        ? "Room height unverified."
        : ceiling.status === "fail" ? "Camera height reaches or exceeds the reported room height."
        : Math.floor(ceiling.margin * 100) + " cm from the camera center to the reported room height.";
      inspectSightlines(from, to);
      const frameCheck = framing(from, to, focal, settings().cameraHeight, curve);
      document.querySelector("#framing").textContent = !frameCheck ? "Place at least two actors to check framing."
        : frameCheck.margin >= 0 ? "Stand-in bounds fit at all sampled positions."
        : "Stand-in bounds clip near " + Math.round(frameCheck.limitingProgress * 100) + "% of the move.";
      document.querySelector("#clearance").dataset.result = margin >= 0 ? "pass" : "fail";
    }
    viewport.dispatchEvent(new CustomEvent("shotpose", {
      detail: {from, to, x, z, center: [cx, cz], tx, tz, actors, aimHeight,
        cameraHeight: settings().cameraHeight, rigRadius: settings().rigRadius, pathPoints: curve?.points},
    }));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((settings().sensorWidthMm / camera.aspect) / (2 * focal)));
    camera.updateProjectionMatrix();
    camera.position.set(x, settings().cameraHeight, z);
    camera.lookAt(previewAim?.[0] ?? tx, aimHeight, previewAim?.[1] ?? tz);
    marks.visible = showMarks.checked;
    outline.visible = reviewing;
    renderer.render(scene, reviewing ? overhead : camera);
    document.querySelector("#shot-time").textContent = "00:" + (t * Number(duration.value)).toFixed(1).padStart(4, "0");
    document.querySelector("#duration-value").textContent = duration.value + " s";
    document.querySelector("#shot-lens").textContent = focal + " mm · 16:9";
    document.querySelector("#rig-value").textContent = rig.value + " m";
    document.querySelector("#sensor-value").textContent = sensor.value + " mm";
    document.querySelector("#focal").textContent = focal + " mm";
    document.querySelector("#distance").textContent = Number(travel.value).toFixed(2) + " m";
  }

  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    button.textContent = "Play shot";
  }

  function tick(now) {
    const progress = Math.min(1, (now - start) / (Number(duration.value) * 1000));
    timeline.value = String(Math.round(progress * 1000));
    render();
    if (progress < 1) frame = requestAnimationFrame(tick);
    else stop();
  }

  const refreshDaylight = captured ? mountDaylight({THREE, room, mesh, scene, renderer, fill, marks, isAligned: () => aligned, canvas: renderer.domElement,
    camera: () => reviewing ? overhead : camera, signal: controls.signal, actors: () => actors, render,
    showFloorPatch: triangles => plan.dispatchEvent(new CustomEvent("sunpatch", {detail: triangles}))}) : null;
  const options = {signal: controls.signal};
  alignmentView.addEventListener("click", () => {
    stop();
    reviewing = !reviewing;
    alignmentView.setAttribute("aria-pressed", String(reviewing));
    alignmentStatus.textContent = reviewing
      ? "The gold line is the metric room boundary. Compare it with the captured walls."
      : "";
    render();
  }, options);
  alignment.elements.height.addEventListener("input", () => {
    alignment.elements.accepted.checked = false;
    const height = alignment.elements.height.valueAsNumber;
    alignmentStatus.textContent = Number.isFinite(height)
      ? "Proposed floor elevation: " + height + " m. Save to apply it and recheck the shot."
      : "Enter a floor elevation in meters.";
  }, options);
  alignment.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = alignment.querySelector('button:not([type="button"])');
    submit.disabled = true;
    try {
      const response = await fetch("/api/room-alignment", {
        method: "POST", headers: {"Content-Type": "application/json"}, signal: controls.signal,
        body: JSON.stringify({model: room.modelId, room: room.roomId ?? null,
          floorHeight: Number(alignment.elements.height.value), accepted: alignment.elements.accepted.checked}),
      });
      const review = await response.json();
      if (controls.signal.aborted) return;
      if (!response.ok) throw Error(review.error);
      room.matterpakFloorHeight = review.floorHeight;
      room.matterpakAlignmentVerified = aligned = review.accepted;
      room.alignmentEvidence = review.note;
      checkScan.disabled = !aligned;
      if (!aligned) checkScan.checked = false;
      save();
      alignMesh(mesh, room);
      refreshDaylight?.reload();
      checkedTravel = undefined;
      alignmentStatus.textContent = review.note;
      render();
    } catch (error) {
      if (!controls.signal.aborted) alignmentStatus.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }, options);
  button.addEventListener("click", () => {
    if (frame) return stop();
    play();
  }, options);
  function play() {
    const initial = Number(timeline.value);
    start = performance.now() - (playFromStart || initial >= 1000 ? 0 : initial * Number(duration.value));
    playFromStart = false;
    button.textContent = "Pause";
    frame = requestAnimationFrame(tick);
  }
  plan.addEventListener("obstacleschange", event => {
    obstacles = event.detail;
    clearFurniture();
    for (const item of obstacles) {
      const [x, z] = item.min;
      const [maxX, maxZ] = item.max;
      const volumeHeight = Math.max(.012, furnitureHeight(item));
      const object = new THREE.Mesh(new THREE.BoxGeometry(maxX - x, volumeHeight, maxZ - z), furnitureMaterial);
      object.position.set((x + maxX) / 2, volumeHeight / 2, (z + maxZ) / 2);
      furniture.add(object);
    }
    checkedTravel = undefined;
    revision.textContent = "";
    render();
  }, options);
  plan.dispatchEvent(new Event("shotmounted"));
  function applyCurve(path) {
    applySetup({pathPoints: path.points, mark: path.at(.5), travel: path.travel,
      moveKind: "curve", lens: Number(lens.value)});
  }
  plan.addEventListener("drawcamera", event => {
    const path = tracePath(event.detail);
    if (!path) {
      revision.textContent = "Draw a camera path between 1 cm and 4 m. The previous shot was kept.";
      return;
    }
    if (reviewing) {
      reviewing = false;
      alignmentView.setAttribute("aria-pressed", "false");
      alignmentStatus.textContent = "";
    }
    timeline.value = "0";
    applyCurve(path);
    revision.textContent = "Playing the drawn curve. Review clearance and framing below.";
    play();
  }, options);
  plan.addEventListener("choosecamera", event => {
    if (curve) {
      const offset = [event.detail[0] - cx, event.detail[1] - cz];
      const path = tracePath(curve.points.map(point => point.map((value, axis) => value + offset[axis])));
      if (path) applyCurve(path);
      return;
    }
    stop();
    [cx, cz] = event.detail;
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    save();
    revision.textContent = "Camera repositioned. Wall clearance recalculated.";
    render();
  }, options);
  plan.addEventListener("chooseaim", event => {
    previewAim = undefined;
    const [x, z] = event.detail;
    if (Math.hypot(x - cx, z - cz) < .01) {
      revision.textContent = "Choose an aim point away from the camera center.";
      render();
      return;
    }
    stop();
    [tx, tz] = [x, z];
    aimLocked = true;
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    save();
    render();
    revision.textContent = "Aim updated. Actor marks were kept.";
  }, options);
  plan.addEventListener("previewaim", event => {
    stop();
    previewAim = event.detail;
    if (previewAim && reviewing) {
      reviewing = false;
      alignmentView.setAttribute("aria-pressed", "false");
      alignmentStatus.textContent = "";
    }
    render();
  }, options);
  function updateAimHeight(input) {
    if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) return;
    stop();
    aimHeight = Number(input.valueAsNumber.toFixed(2));
    if (input === aimSlider) {
      aimSlider.value = String(aimHeight);
      aimElevation.value = aimHeight.toFixed(2);
    }
    else {
      aimSlider.max = String(Math.max(4, Math.ceil(aimHeight)));
      aimSlider.value = String(aimHeight);
    }
    checkedTravel = undefined;
    save();
    render();
  }
  aimSlider.addEventListener("input", () => updateAimHeight(aimSlider), options);
  aimElevation.addEventListener("input", () => updateAimHeight(aimElevation), options);
  aimElevation.addEventListener("blur", syncAimHeight, options);
  document.querySelector("#center-aim").addEventListener("click", () => {
    const center = actorCenter(actors);
    if (!center) {
      revision.textContent = "Place an actor to center the aim.";
      return;
    }
    stop();
    aimLocked = false;
    [tx, tz] = center;
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    save();
    render();
    revision.textContent = "Aim centered between the actor marks.";
  }, options);
  plan.addEventListener("chooseendpoint", event => {
    const {which, point} = event.detail;
    if (curve) {
      const points = curve.points.slice();
      points[which === "start" ? 0 : points.length - 1] = point;
      const path = tracePath(points);
      if (!path) {
        revision.textContent = "The updated curve must be between 1 cm and 4 m.";
        return;
      }
      timeline.value = which === "start" ? "0" : "1000";
      applyCurve(path);
      revision.textContent = "Curve " + which + " updated.";
      return;
    }
    const [from, to] = endpoints(Number(travel.value));
    const path = pathFromEndpoints(which === "start" ? point : from, which === "end" ? point : to);
    if (path.travel > Number(travel.max) || !Number.isFinite(path.travel)) {
      revision.textContent = "The camera marks must be within " + travel.max + " m of each other.";
      return;
    }
    moveKind.value = path.travel < 1e-8 ? "static" : "custom";
    travel.disabled = moveKind.value === "static";
    timeline.value = which === "start" ? "0" : "1000";
    applySetup({...path, lens: Number(lens.value)});
    revision.textContent = "Camera " + which + " updated. See framing and clearance above.";
  }, options);
  plan.addEventListener("chooseactor", event => {
    const {index, point} = event.detail;
    if (!Number.isInteger(index) || index < 0 || index >= maxActors || index > actors.length) return;
    const wasPlaced = Boolean(actors[index]);
    if (checkRigClearance(room.outline, obstacles, point, point, .17).margin < 0) {
      revision.textContent = "Place the actor inside the room and clear of marked furniture.";
      return;
    }
    if (actors.some((other, i) => i !== index && other &&
        Math.hypot(other[0] - point[0], other[1] - point[1]) < .34)) {
      revision.textContent = "Leave at least 34 cm between actor marks.";
      return;
    }
    stop();
    actors[index] = point;
    updateStandIns();
    if (!aimLocked) [tx, tz] = actorCenter(actors);
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    showMarks.checked = true;
    save();
    render();
    void refreshDaylight?.evaluate();
    revision.textContent = wasPlaced ? (aimLocked ? "Actor mark moved. Manual aim kept." : "Actor mark moved and camera aim re-centered.")
      : `Actor ${index + 1} placed.`;
  }, options);
  function planShot({distance, focal = Number(lens.value), cameraHeight = settings().cameraHeight, objective = "travel", requireSightlines = false}) {
    if (curve) return {reason: "Redraw the curve to change its route, or select a straight move for automatic planning."};
    if (!hasCast()) return {reason: "Place at least two actors before planning the shot."};
    const ceiling = checkCameraHeight(room, cameraHeight);
    if (ceiling.status === "fail")
      return {reason: "Lower the camera below the reported room height.", ceiling};
    const checkMesh = requireSightlines || checkScan.checked;
    if (checkMesh && !aligned) {
      return {reason: "Captured sightlines require an aligned scan and actor marks."};
    }
    const baseline = framing(...endpoints(Number(travel.value)));
    if (objective === "tighter" && (!baseline || !Number.isFinite(baseline.margin))) {
      return {reason: "A tighter two-shot needs valid actor marks and a baseline frame."};
    }
    let raysChecked = 0;
    let reachedSampleLimit = false;
    const result = findSlide(room.outline, [cx, cz], [tx, tz], moveAxis(), moveKind.value === "static" ? 0 : distance,
      settings().rigRadius, keepMark.checked, obstacles, (from, to) => {
        const frame = framing(from, to, focal, cameraHeight);
        if (frame && frame.margin < 0) return false;
        if (objective === "tighter" && frame.margin > baseline.margin - .03) return false;
        if (!checkMesh) return true;
        if (raysChecked >= 16) {
          reachedSampleLimit = true;
          return false;
        }
        raysChecked++;
        return !meshObstruction(from, to, cameraHeight);
      });
    if (!result.mark) {
      return {reason: reachedSampleLimit
        ? "Reached the mesh sampling limit after " + raysChecked + " sightline checks."
        : "None of " + result.checked + " candidate setups passed the requested checks."};
    }
    const shift = Math.hypot(result.mark[0] - cx, result.mark[1] - cz);
    const axis = moveAxis() || [tz - result.mark[1], result.mark[0] - tx];
    const [start, end] = slideEndpoints(result.mark, axis, result.length);
    const verifiedFrame = framing(start, end, focal, cameraHeight);
    return {
      setup: {cameraHeight, aimHeight, mark: result.mark, travel: result.length, lens: focal,
        sensorWidthMm: settings().sensorWidthMm, rigRadius: settings().rigRadius,
        moveKind: moveKind.value, axis, aim: [tx, tz],
        actors: actors.map(point => point?.slice() ?? null), requireSightlines: checkMesh},
      ceiling, clearanceMargin: result.margin, framingMargin: verifiedFrame?.margin, sightlinesSampled: raysChecked > 0,
      reason: "Checked " + result.checked + " setups. " +
        (shift ? "Shifted the camera mark " + shift.toFixed(2) + " m. " : "") +
        (result.length ? "Found " + result.length.toFixed(2) + " m of camera travel. " : "Found a static shot. ") +
        (objective === "tighter" ? "The tightest framing margin decreased by at least 3 percentage points. " : "") +
        (raysChecked ? "Captured sightlines sampled." : ""),
    };
  }

  function applySetup(setup) {
    stop();
    curve = setup.moveKind === "curve" ? tracePath(setup.pathPoints) : null;
    const pose = editorShotState({
      ...setup, aim: setup.aim || [tx, tz], actors: setup.actors || actors,
      moveKind: setup.moveKind || moveKind.value, slideAxis: room.slideAxis,
    });
    [cx, cz] = pose.mark;
    fixedMoveAxis = Array.isArray(setup.axis) ? setup.axis.slice() : setup.axis;
    if (setup.moveKind) {
      moveKind.value = setup.moveKind;
      travel.disabled = Boolean(curve) || setup.moveKind === "static";
    }
    if (Array.isArray(setup.aim)) {
      [tx, tz] = setup.aim;
      if (setup.aimLocked != null) aimLocked = setup.aimLocked;
    }
    if (Array.isArray(setup.actors)) {
      actors.splice(0, actors.length, ...actorMarks(room, setup));
      updateStandIns();
    }
    if (setup.showStandIns === true && hasCast()) showMarks.checked = true;
    checkedTravel = undefined;
    lens.value = pose.lens;
    if (Number.isFinite(setup.rigRadius)) rig.value = setup.rigRadius;
    if (Number.isFinite(setup.sensorWidthMm)) sensor.value = setup.sensorWidthMm;
    if (Number.isFinite(setup.cameraHeight)) {
      height.value = setup.cameraHeight;
      pathHeightValue.value = setup.cameraHeight.toFixed(2);
    }
    if (Number.isFinite(setup.aimHeight)) {
      aimHeight = setup.aimHeight;
      syncAimHeight();
    }
    if (Number.isFinite(setup.durationSeconds)) duration.value = setup.durationSeconds;
    if (typeof setup.requireSightlines === "boolean") checkScan.checked = setup.requireSightlines;
    if (typeof setup.keepMark === "boolean") keepMark.checked = setup.keepMark;
    travel.value = String(curve?.travel ?? pose.travel);
    save();
    render();
  }

  function replan(distance, {fromNote = false, requireSightlines = false} = {}) {
    const proposal = planShot({distance, requireSightlines});
    if (proposal.setup) applySetup(proposal.setup);
    revision.textContent = (fromNote ? "Target: " + distance.toFixed(2) + " m slide. " : "") +
      proposal.reason + (proposal.setup ? " Lens and aim are fixed." : " Current shot kept.");
  }

  fit.addEventListener("click", () => {
    const requested = Number(travel.value);
    const proposal = planShot({distance: requested});
    if (!proposal.setup) {
      revision.textContent = proposal.reason + " Current shot kept.";
      return;
    }
    if (proposal.setup.travel < .01) {
      revision.textContent = "Only a static shot passed these checks. Current move kept.";
      return;
    }
    applySetup(proposal.setup);
    const travelText = proposal.setup.travel < requested - .001
      ? `Shortened the move from ${requested.toFixed(2)} m to ${proposal.setup.travel.toFixed(2)} m.`
      : `Kept the ${requested.toFixed(2)} m move.`;
    revision.textContent = travelText + " " + proposal.reason;
  }, options);
  document.querySelector("#view-obstruction").addEventListener("click", () => {
    if (!blockedView) return;
    stop();
    playFromStart = false;
    timeline.value = String(Math.round(timeFractionAtPath(blockedView.t) * 1000));
    render();
  }, options);
  directionForm.addEventListener("submit", event => {
    event.preventDefault();
    const direction = interpretDirection(directionForm.querySelector("input").value, Number(travel.value));
    if (direction) replan(direction.distance, {fromNote: true});
    else revision.textContent = "Try a shorter slide, a longer slide, or a distance in meters.";
  }, options);
  timeline.addEventListener("input", () => {
    playFromStart = false;
    stop();
    render();
  }, options);
  exportShot.addEventListener("click", () => {
    const distance = Number(travel.value);
    const [start, end] = endpoints(distance);
    const {margin, feature} = clearance(start, end);
    const sampledMesh = aligned && hasCast();
    const obstruction = sampledMesh ? meshObstruction(start, end, settings().cameraHeight, curve) : null;
    const durationSeconds = Number(duration.value);
    const secondsAt = fraction => timeFractionAtPath(fraction) * durationSeconds;
    const shot = {
      schemaVersion: 1, interpolation: "smoothstep", aimLocked,
      keepMark: keepMark.checked, requireSightlines: checkScan.checked,
      modelId: room.modelId, roomId: room.roomId || null, units: "meters", actors, start, end, pathPoints: curve?.points, aim: [tx, tz],
      cameraHeight: settings().cameraHeight, aimHeight,
      sensorWidthMm: settings().sensorWidthMm, focalLengthMm: Number(lens.value), aspect: [16, 9],
      durationSeconds, moveKind: moveKind.value, rigRadius: settings().rigRadius, clearanceCheck: margin >= 0 ? "pass" : "fail",
      cameraHeightCheck: checkCameraHeight(room, settings().cameraHeight),
      clearanceMargin: margin, limitingFeature: feature, obstacles, unmarkedFurniture: "unchecked",
      meshSightline: sampledMesh
        ? {status: obstruction ? "obstruction detected" : "clear at five samples",
          obstruction: obstruction ? {actor: obstruction.actor, pathFraction: obstruction.t,
            timeSeconds: secondsAt(obstruction.t)} : null}
        : {status: "unknown"},
      framing: (() => {
        const check = framing(start, end, Number(lens.value), settings().cameraHeight, curve);
        if (!check) return {status: "unknown"};
        return {status: check.margin >= 0 ? "pass" : "fail",
          normalizedMargin: Number.isFinite(check.margin) ? check.margin : null,
          limitingProgress: check.limitingProgress,
          limitingTimeSeconds: secondsAt(check.limitingProgress)};
      })(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(shot, null, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = room.modelId + "-shot.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, options);
  showMarks.addEventListener("change", () => { save(); render(); }, options);
  moveKind.addEventListener("change", () => {
    if (moveKind.value === "curve" && curve) return;
    stop();
    curve = null;
    if (moveKind.value === "curve") moveKind.value = "custom";
    fixedMoveAxis = undefined;
    checkedTravel = undefined;
    travel.disabled = moveKind.value === "static";
    if (travel.disabled) travel.value = "0";
    revision.textContent = "";
    save();
    render();
  }, options);
  keepMark.addEventListener("change", save, options);
  checkScan.addEventListener("change", save, options);
  function updateShotControls() {
    checkedTravel = undefined;
    revision.textContent = "";
    save();
    render();
  }
  for (const input of [lens, travel, sensor, rig]) input.addEventListener("input", updateShotControls, options);
  height.addEventListener("input", () => {
    pathHeightValue.value = Number(height.value).toFixed(2);
    height.value = pathHeightValue.value;
    updateShotControls();
  }, options);
  pathHeightValue.addEventListener("input", () => {
    if (pathHeightValue.validity.valid && Number.isFinite(pathHeightValue.valueAsNumber)) {
      height.value = pathHeightValue.valueAsNumber.toFixed(2);
      updateShotControls();
    }
  }, options);
  pathHeightValue.addEventListener("blur", () => {
    pathHeightValue.value = Number(height.value).toFixed(2);
  }, options);
  for (const exactHeight of [pathHeightValue, aimElevation]) {
    exactHeight.addEventListener("keydown", event => {
      if (event.key === "Enter") exactHeight.blur();
    }, options);
  }
  const resize = new ResizeObserver(() => {
    if (!viewport.clientWidth) return;
    renderer.setSize(viewport.clientWidth, Math.round(viewport.clientWidth * 9 / 16), false);
    render();
  });
  resize.observe(viewport);
  duration.addEventListener("input", () => {
    stop();
    save();
    render();
  }, options);
  if (room.proposedShot) save();

  return {plan: planShot, apply: applySetup, snapshot() {
    return {mark: [cx, cz], ...settings(), aimHeight, lens: Number(lens.value), travel: curve?.travel ?? Number(travel.value),
      moveKind: moveKind.value, axis: fixedMoveAxis, pathPoints: curve?.points, keepMark: keepMark.checked, requireSightlines: checkScan.checked, showStandIns: showMarks.checked, obstacles, actors: actors.map(point => point?.slice() ?? null), aimLocked, aim: [tx, tz]};
  }, dispose() {
    stop();
    controls.abort();
    resize.disconnect();
    clearTimeout(sightlineTimer);
    release();
    outline.geometry.dispose();
    outline.material.dispose();
    const figureMaterials = new Set();
    marks.traverse(object => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      figureMaterials.add(object.material);
    });
    for (const material of figureMaterials) material.dispose();
    clearFurniture();
    furnitureMaterial.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }};
}
