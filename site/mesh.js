import {mountDaylight} from "./daylight.js";
import {alignMesh, sightlineCheck} from "./sightlines.js";
import {actorMarks, checkCameraHeight, loadShot, roomKey, shotSettings} from "./room-state.js";
import {cameraMoveAxis, checkFraming, checkRigClearance, easedPathFraction, editorShotState, findSlide, interpretDirection, pathFromEndpoints, timeFractionAtPath} from "./path.js";

const viewport = document.querySelector("#viewport");
const status = document.querySelector("#render-status");
const transport = document.querySelector("#transport");
const sightline = document.querySelector("#sightline");
const sightlineActions = document.querySelector("#sightline-actions");
const timeline = document.querySelector("#timeline");
const lens = document.querySelector("#lens");
const sensor = document.querySelector("#sensor-width");
const height = document.querySelector("#camera-height");
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
const alignment = document.querySelector("#alignment");
const alignmentView = document.querySelector("#alignment-view");
const alignmentStatus = document.querySelector("#alignment-status");
const checkScan = document.querySelector("#check-scan");
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
  revision.textContent = "";
  document.querySelector("#clearance").textContent = "";
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
  const actors = actorMarks(room, saved);
  const marks = new THREE.Group();
  for (const [index, point] of actors.entries()) {
    const [x, z] = point || [0, 0];
    const material = new THREE.MeshStandardMaterial({
      color: index ? 0x728d9f : 0xb98c66, roughness: .9,
    });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.17, 1.03, 8, 16), material);
    torso.position.set(x, .69, z);
    const head = new THREE.Mesh(new THREE.SphereGeometry(.115, 24, 16), material);
    head.position.set(x, 1.49, z);
    torso.visible = head.visible = Boolean(point);
    marks.add(torso, head);
  }
  scene.add(marks, new THREE.HemisphereLight(0xffffff, 0xb7a28f, 2.3));
  showMarks.checked = false;
  let aligned = captured && room.matterpakAlignmentVerified === true;
  checkScan.disabled = !aligned;
  checkScan.checked = false;

  const midpoint = room.outline.reduce(([x, z], [px, pz]) => [x + px, z + pz], [0, 0])
    .map(value => value / room.outline.length);
  let [cx, cz] = room.camera || midpoint;
  let aimLocked = saved.aimLocked === true;
  let [tx, tz] = saved.aim || room.lookAt || (actors.every(Boolean)
    ? actors[0].map((value, index) => (value + actors[1][index]) / 2)
    : actors.find(Boolean) || [midpoint[0], midpoint[1] - 1]);

  const key = "scout-shot:" + roomKey(room);
  if (Array.isArray(saved?.mark) && saved.mark.length === 2 && saved.mark.every(Number.isFinite)) {
    [cx, cz] = saved.mark;
  }
  const initialSettings = shotSettings(room, saved);
  let aimHeight = initialSettings.aimHeight;
  duration.value = initialSettings.durationSeconds;
  rig.value = initialSettings.rigRadius;
  sensor.value = initialSettings.sensorWidthMm;
  height.value = initialSettings.cameraHeight;
  lens.value = Number.isFinite(saved?.lens) ? saved.lens : 35;
  travel.value = Number.isFinite(saved?.travel) ? saved.travel : .7;
  keepMark.checked = saved?.keepMark !== false;
  checkScan.checked = saved?.requireSightlines === true;
  moveKind.value = ["slide", "push", "pull", "static", "custom"].includes(saved?.moveKind) ? saved.moveKind : "slide";
  if (moveKind.value === "static") travel.value = "0";
  travel.disabled = moveKind.value === "static";

  function save() {
    try {
      localStorage.setItem(key, JSON.stringify({
        mark: [cx, cz], ...settings(), aimHeight, lens: Number(lens.value), travel: Number(travel.value), keepMark: keepMark.checked, moveKind: moveKind.value, axis: fixedMoveAxis, requireSightlines: checkScan.checked, actors, aimLocked, aim: [tx, tz],
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
  function meshObstruction(from, to, cameraHeight = settings().cameraHeight) {
    if (!captured) return null;
    if (rayHeight !== cameraHeight) {
      raycast = sightlineCheck(THREE, mesh, actors, cameraHeight);
      rayHeight = cameraHeight;
    }
    return raycast(from, to);
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
    const pose = editorShotState({
      mark: [cx, cz], axis: fixedMoveAxis, travel: distance, moveKind: moveKind.value,
      aim: [tx, tz], actors, lens: Number(lens.value), slideAxis: room.slideAxis,
    });
    return [pose.start, pose.end];
  }

  function framing(from, to, focal = Number(lens.value), cameraHeight = settings().cameraHeight) {
    if (!actors.every(Boolean)) return null;
    return checkFraming(from, to, [tx, tz], actors, {
      focal, width: settings().sensorWidthMm, aspect: camera.aspect,
      cameraHeight, aimHeight,
    });
  }

  function inspectSightlines(from, to) {
    clearTimeout(sightlineTimer);
    blockedView = null;
    sightlineActions.hidden = true;
    if (!aligned || !actors.every(Boolean)) {
      sightline.textContent = captured && !aligned ? "Captured sightlines unknown: scan alignment is unverified." : "";
      return;
    }
    sightline.textContent = "Sampling sightlines against the captured mesh…";
    sightlineTimer = setTimeout(() => {
      const hit = meshObstruction(from, to);
      blockedView = hit;
      sightlineActions.hidden = !hit;
      sightline.textContent = hit
        ? "Captured mesh blocks stand-in " + hit.actor + " near " + Math.round(hit.t * 100) + "% of path distance."
        : "No captured obstruction at five sampled eye-level positions. Scan gaps may hide obstacles.";
    }, 140);
  }

  function render() {
    const distance = Number(travel.value);
    const [from, to] = endpoints(distance);
    const t = Number(timeline.value) / 1000;
    const eased = easedPathFraction(t);
    const [x, z] = from.map((value, index) => value + (to[index] - value) * eased);
    const focal = Number(lens.value);
    if (checkedTravel !== distance || checkedLens !== focal) {
      checkedTravel = distance;
      checkedLens = focal;
      const {margin, feature} = checkRigClearance(room.outline, obstacles, from, to, settings().rigRadius);
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
      const frameCheck = framing(from, to);
      document.querySelector("#framing").textContent = !frameCheck ? "Place both actor marks to check two-shot framing."
        : frameCheck.margin >= 0 ? "Stand-in bounds fit at all sampled positions."
        : "Stand-in bounds clip near " + Math.round(frameCheck.limitingProgress * 100) + "% of the move.";
      document.querySelector("#clearance").dataset.result = margin >= 0 ? "pass" : "fail";
    }
    viewport.dispatchEvent(new CustomEvent("shotpose", {detail: {from, to, x, z, tx, tz, actors}}));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((settings().sensorWidthMm / camera.aspect) / (2 * focal)));
    camera.updateProjectionMatrix();
    camera.position.set(x, settings().cameraHeight, z);
    camera.lookAt(tx, aimHeight, tz);
    marks.visible = showMarks.checked;
    outline.visible = reviewing;
    renderer.render(scene, reviewing ? overhead : camera);
    document.querySelector("#shot-time").textContent = "00:" + (t * Number(duration.value)).toFixed(1).padStart(4, "0");
    document.querySelector("#duration-value").textContent = duration.value + " s";
    document.querySelector("#shot-lens").textContent = focal + " mm · 16:9";
    document.querySelector("#rig-value").textContent = rig.value + " m";
    document.querySelector("#sensor-value").textContent = sensor.value + " mm";
    document.querySelector("#height-value").textContent = height.value + " m";
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

  const refreshDaylight = captured ? mountDaylight({THREE, room, mesh, scene, renderer, isAligned: () => aligned, canvas: renderer.domElement,
    camera: () => reviewing ? overhead : camera, signal: controls.signal, actors: () => actors, render}) : null;
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
    const initial = Number(timeline.value);
    start = performance.now() - (playFromStart || initial >= 1000 ? 0 : initial * Number(duration.value));
    playFromStart = false;
    button.textContent = "Pause";
    frame = requestAnimationFrame(tick);
  }, options);
  plan.addEventListener("obstacleschange", event => {
    obstacles = event.detail;
    checkedTravel = undefined;
    revision.textContent = "";
    render();
  }, options);
  plan.dispatchEvent(new Event("shotmounted"));
  plan.addEventListener("choosecamera", event => {
    stop();
    [cx, cz] = event.detail;
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    save();
    revision.textContent = "Camera repositioned. Wall clearance recalculated.";
    render();
  }, options);
  plan.addEventListener("chooseaim", event => {
    const [x, z] = event.detail;
    if (Math.hypot(x - cx, z - cz) < .01) {
      revision.textContent = "Choose an aim point away from the camera center.";
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
  document.querySelector("#center-aim").addEventListener("click", () => {
    if (!actors.every(Boolean)) {
      revision.textContent = "Place both actors to center the aim.";
      return;
    }
    stop();
    aimLocked = false;
    [tx, tz] = actors[0].map((value, index) => (value + actors[1][index]) / 2);
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    save();
    render();
    revision.textContent = "Aim centered between the actor marks.";
  }, options);
  plan.addEventListener("chooseendpoint", event => {
    const {which, point} = event.detail;
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
    if (index !== 0 && index !== 1) return;
    const wasPlaced = Boolean(actors[index]);
    if (checkRigClearance(room.outline, obstacles, point, point, .17).margin < 0) {
      revision.textContent = "Place the actor inside the room and clear of marked furniture.";
      return;
    }
    const other = actors[1 - index];
    if (other && Math.hypot(other[0] - point[0], other[1] - point[1]) < .34) {
      revision.textContent = "Leave enough space between the two actor marks.";
      return;
    }
    stop();
    actors[index] = point;
    for (const child of marks.children.slice(index * 2, index * 2 + 2)) {
      [child.position.x, child.position.z] = point;
      child.visible = true;
    }
    if (!aimLocked) [tx, tz] = actors.every(Boolean)
      ? actors[0].map((value, axis) => (value + actors[1][axis]) / 2) : point;
    if (moveKind.value !== "custom") fixedMoveAxis = undefined;
    checkedTravel = undefined;
    showMarks.checked = true;
    save();
    render();
    void refreshDaylight?.evaluate();
    revision.textContent = wasPlaced ? (aimLocked ? "Actor mark moved. Manual aim kept." : "Actor mark moved and camera aim re-centered.")
      : actors.every(Boolean) ? "Both actor marks are set." : "Actor mark set. Place the other actor to check the two-shot.";
  }, options);
  function planShot({distance, focal = Number(lens.value), cameraHeight = settings().cameraHeight, objective = "travel", requireSightlines = false}) {
    if (!actors.every(Boolean)) return {reason: "Place both actor marks before planning a two-shot."};
    const ceiling = checkCameraHeight(room, cameraHeight);
    if (ceiling.status === "fail")
      return {reason: "Lower the camera below the reported room height.", ceiling};
    const checkMesh = requireSightlines || checkScan.checked;
    if (checkMesh && (!aligned || !actors.every(Boolean))) {
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
    return {
      setup: {cameraHeight, aimHeight, mark: result.mark, travel: result.length, lens: focal,
        sensorWidthMm: settings().sensorWidthMm, rigRadius: settings().rigRadius,
        moveKind: moveKind.value, axis: moveAxis(), aim: [tx, tz],
        actors: actors.map(point => point.slice()), requireSightlines: checkMesh},
      ceiling, clearanceMargin: result.margin, sightlinesSampled: raysChecked > 0,
      reason: "Checked " + result.checked + " setups. " +
        (shift ? "Shifted the camera mark " + shift.toFixed(2) + " m. " : "") +
        (result.length ? "Found " + result.length.toFixed(2) + " m of camera travel. " : "Found a static shot. ") +
        (objective === "tighter" ? "The tightest framing margin decreased by at least 3 percentage points. " : "") +
        (raysChecked ? "Captured sightlines sampled." : ""),
    };
  }

  function applySetup(setup) {
    stop();
    const pose = editorShotState({
      ...setup, aim: setup.aim || [tx, tz], actors: setup.actors || actors,
      moveKind: setup.moveKind || moveKind.value, slideAxis: room.slideAxis,
    });
    [cx, cz] = pose.mark;
    fixedMoveAxis = Array.isArray(setup.axis) ? setup.axis.slice() : setup.axis;
    if (setup.moveKind) {
      moveKind.value = setup.moveKind;
      travel.disabled = setup.moveKind === "static";
    }
    if (Array.isArray(setup.aim)) {
      [tx, tz] = setup.aim;
      if (setup.aimLocked != null) aimLocked = setup.aimLocked;
    }
    if (Array.isArray(setup.actors)) {
      for (let index = 0; index < 2; index++) {
        const point = Array.isArray(setup.actors[index]) ? setup.actors[index].slice() : null;
        actors[index] = point;
        for (const child of marks.children.slice(index * 2, index * 2 + 2)) {
          if (point) [child.position.x, child.position.z] = point;
          child.visible = Boolean(point);
        }
      }
    }
    checkedTravel = undefined;
    lens.value = pose.lens;
    if (Number.isFinite(setup.rigRadius)) rig.value = setup.rigRadius;
    if (Number.isFinite(setup.sensorWidthMm)) sensor.value = setup.sensorWidthMm;
    if (Number.isFinite(setup.cameraHeight)) height.value = setup.cameraHeight;
    if (Number.isFinite(setup.aimHeight)) aimHeight = setup.aimHeight;
    if (Number.isFinite(setup.durationSeconds)) duration.value = setup.durationSeconds;
    if (typeof setup.requireSightlines === "boolean") checkScan.checked = setup.requireSightlines;
    if (typeof setup.keepMark === "boolean") keepMark.checked = setup.keepMark;
    travel.value = String(pose.travel);
    save();
    render();
  }

  function replan(distance, {fromNote = false, requireSightlines = false} = {}) {
    const proposal = planShot({distance, requireSightlines});
    if (proposal.setup) applySetup(proposal.setup);
    revision.textContent = (fromNote ? "Target: " + distance.toFixed(2) + " m slide. " : "") +
      proposal.reason + (proposal.setup ? " Lens and aim are fixed." : " Current shot kept.");
  }

  fit.addEventListener("click", () => replan(Number(travel.value)), options);
  document.querySelector("#view-obstruction").addEventListener("click", () => {
    if (!blockedView) return;
    stop();
    playFromStart = false;
    timeline.value = String(Math.round(timeFractionAtPath(blockedView.t) * 1000));
    render();
  }, options);
  document.querySelector("#fit-sightlines").addEventListener("click", () => {
    replan(Number(travel.value), {requireSightlines: true});
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
    const {margin, feature} = checkRigClearance(room.outline, obstacles, start, end, settings().rigRadius);
    const sampledMesh = aligned && actors.every(Boolean);
    const obstruction = sampledMesh ? meshObstruction(start, end) : null;
    const durationSeconds = Number(duration.value);
    const secondsAt = fraction => timeFractionAtPath(fraction) * durationSeconds;
    const shot = {
      schemaVersion: 1, interpolation: "smoothstep", aimLocked,
      keepMark: keepMark.checked, requireSightlines: checkScan.checked,
      modelId: room.modelId, roomId: room.roomId || null, units: "meters", actors, start, end, aim: [tx, tz],
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
        const check = framing(start, end);
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
  showMarks.addEventListener("change", render, options);
  moveKind.addEventListener("change", () => {
    stop();
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
  for (const input of [lens, travel, sensor, height, rig]) input.addEventListener("input", () => {
    checkedTravel = undefined;
    revision.textContent = "";
    save();
    render();
  }, options);
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
    return {mark: [cx, cz], ...settings(), aimHeight, lens: Number(lens.value), travel: Number(travel.value),
      moveKind: moveKind.value, axis: fixedMoveAxis, keepMark: keepMark.checked, requireSightlines: checkScan.checked, obstacles, actors: actors.map(point => point?.slice() ?? null), aimLocked, aim: [tx, tz]};
  }, dispose() {
    stop();
    controls.abort();
    resize.disconnect();
    clearTimeout(sightlineTimer);
    release();
    outline.geometry.dispose();
    outline.material.dispose();
    for (const object of marks.children) object.geometry.dispose();
    for (const material of new Set(marks.children.map(object => object.material))) material.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }};
}
