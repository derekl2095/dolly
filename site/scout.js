import {maxCurvePoints, readShotExport, roundStroke, tracePath} from "./path.js?v=volume";
import {deleteProject, parseProjectArchive, projectArchiveMaxBytes, readProjects, writeProject} from "./projects.js?v=volume";
import {defaultFurnitureHeight, furnitureHeight, loadObstacles, maxActors, outlineMeasurements, roomKey, standIn} from "./room-state.js?v=volume";
import {planProjection} from "./plan-projection.js";
import {capturedSpaceLabel, cleanPropertyDescription, isVoidRoom, listedArea, spaceLabel} from "./location-labels.js?v=dolly";
import {briefSuggestions, runAgent} from "./agent.js?v=room-polish";
import {compareCapturedRooms} from "./compare.js?v=room-polish";
import {openMesh, closeMesh, currentShot, currentShotCanCheckSightlines, planCurrentShot, applyCurrentShot} from "./mesh.js?v=sheep-planner";
import {addMapLocations, resetLocationMap} from "./location-map.js?v=location-polish";

const form = document.querySelector("#scout-search");
const results = document.querySelector("#results");
const workspace = document.querySelector("#workspace");
const roomTitle = document.querySelector("#room-title");
const roomLocation = document.querySelector("#room-location");
const roomGeometry = document.querySelector("#room-geometry");
const projectLocation = document.querySelector("#project-location");
const roomPanel = roomTitle.closest("aside");
const backToResults = document.querySelector("#back-to-results");
const collapseScouting = document.querySelector("#collapse-scouting");
const expandScouting = document.querySelector("#expand-scouting");
const scouting = document.querySelector("#scouting");
function setSidebarVisible(visible) {
  scouting.hidden = !visible;
  expandScouting.hidden = visible;
}
collapseScouting.addEventListener("click", () => {
  setSidebarVisible(false);
  expandScouting.focus();
});
expandScouting.addEventListener("click", () => {
  setSidebarVisible(true);
  collapseScouting.focus();
});
backToResults.addEventListener("click", () => {
  if (Object.hasOwn(workspace.dataset, "browse")) {
    delete workspace.dataset.browse;
    roomTitle.focus();
    return;
  }
  setSidebarVisible(true);
  workspace.dataset.browse = "";
  form.querySelector("input[name=q]").focus();
});
const status = document.querySelector("#status");
const roomStatus = document.querySelector("#room-status");
const canvas = document.querySelector("#plan");
const rigWidth = document.querySelector("#rig-width");
let roomRequest;
let selectedRoom;
let activeLocation = "";
let activeScan;
let activePropertyId;

function updateActiveProperty() {
  for (const card of results.children) {
    const scans = card.querySelector("select");
    const containsScan = activeScan && scans && [...scans.options].some(option => option.value === activeScan);
    const active = activePropertyId ? card.dataset.propertyId === activePropertyId : containsScan;
    if (active) {
      card.setAttribute("aria-current", "true");
      if (containsScan && scans.value !== activeScan) {
        scans.value = activeScan;
        scans.dispatchEvent(new Event("change"));
      }
    } else card.removeAttribute("aria-current");
  }
}

function showLocation(location = "") {
  activeLocation = location;
  projectLocation.textContent = location || "No location selected";
  const prefix = roomTitle.textContent + " · ";
  roomLocation.textContent = location.startsWith(prefix) ? location.slice(prefix.length) : location;
  roomLocation.hidden = !location;
}

function propertyLabel({name, street, city, state}) {
  const address = [street, city, state].filter(Boolean).join(", ");
  return [name !== street ? name : "", address].filter(Boolean).join(" · ");
}
const roomPicker = document.querySelector("#room-picker");
const roomOptions = roomPicker.querySelector("select");

function roomName(label, id, caption) {
  const name = spaceLabel(label);
  if (name && !/^(?:other|room)(?:\s+\d+)?$/i.test(name) && name !== id && name !== `Room ${id}`) return name;
  const contextName = spaceLabel(caption);
  return /\b(?:room|office|showroom|kitchen|bedroom|studio|lobby|suite|warehouse|patio)\b/i.test(contextName)
    ? contextName : "Room";
}

function roomNames(choices, caption) {
  const names = choices.map(({label, id}) => roomName(label, id, choices.length === 1 ? caption : ""));
  const totals = new Map();
  const numbers = new Map();
  for (const name of names) totals.set(name, (totals.get(name) || 0) + 1);
  return names.map(name => {
    if (totals.get(name) === 1) return name;
    const number = (numbers.get(name) || 0) + 1;
    numbers.set(name, number);
    return `${name} ${number}`;
  });
}

function namedRoomFromOutline(name, outline) {
  const generic = /^Room(?: (\d+))?$/.exec(name);
  if (!generic || !Array.isArray(outline) || outline.length < 3 ||
      !outline.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return name;
  const {xSpan, zSpan, area} = outlineMeasurements(outline);
  if (!xSpan || !zSpan) return name;
  const fill = area / (xSpan * zSpan);
  const shape = fill >= .9 ? (Math.max(xSpan, zSpan) / Math.min(xSpan, zSpan) >= 1.8
    ? "Long room" : "Rectangular room") : "Irregular room";
  return generic[1] ? `${shape} ${generic[1]}` : shape;
}

document.querySelector("#retry-mesh").addEventListener("click", async () => {
  if (!selectedRoom || !roomRequest) return;
  closeMesh();
  await openMesh(selectedRoom, roomRequest.signal);
  if (retryMesh.hidden) importMesh.hidden = true;
});
const importMesh = document.querySelector("#import-mesh");
const retryMesh = document.querySelector("#retry-mesh");
const renderStatus = document.querySelector("#render-status");
importMesh.addEventListener("click", () => prepareMatterPak(selectedRoom, roomRequest));

async function prepareMatterPak(room, request) {
  if (!room || !request) return;
  importMesh.disabled = retryMesh.disabled = true;
  renderStatus.textContent = "Downloading the selected MatterPak…";
  try {
    const response = await fetch("/api/import-matterpak", {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify({model: room.modelId}),
      signal: request.signal});
    const result = await response.json();
    if (request.signal.aborted) return;
    if (!response.ok) throw Error(result.error || "MatterPak import failed.");
    const shot = currentShot() ?? room.proposedShot;
    const params = new URLSearchParams({model: room.modelId});
    if (room.roomId) params.set("room", room.roomId);
    const detail = await fetch("/api/room?" + params, {signal: request.signal});
    if (!detail.ok) throw Error("The MatterPak was saved. Reopen the room to load it.");
    const updated = await detail.json();
    if (request.signal.aborted) return;
    selectedRoom = shot ? {...updated, proposedShot: shot} : updated;
    closeMesh();
    await openMesh(selectedRoom, request.signal);
  } catch (error) {
    if (!request.signal.aborted) renderStatus.textContent = error.message;
  } finally {
    if (!request.signal.aborted) {
      importMesh.hidden = retryMesh.hidden;
      importMesh.disabled = retryMesh.disabled = false;
    }
  }
}
const uploadMesh = document.querySelector("#upload-mesh");
const meshFile = uploadMesh.querySelector("input");
meshFile.addEventListener("change", async () => {
  const file = meshFile.files[0];
  meshFile.value = "";
  const room = selectedRoom;
  const request = roomRequest;
  if (!file || !room || !request) return;
  meshFile.disabled = true;
  renderStatus.textContent = "Importing the selected MatterPak ZIP…";
  try {
    const response = await fetch("/api/upload-matterpak?" + new URLSearchParams({model: room.modelId}), {
      method: "POST", headers: {"Content-Type": "application/zip"}, body: file, signal: request.signal,
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    if (!request.signal.aborted)
      await inspectRoom({name: room.label || room.modelId}, room.modelId, room.roomId, currentShot());
  } catch (error) {
    if (!request.signal.aborted) renderStatus.textContent = error.message;
  } finally {
    meshFile.disabled = false;
  }
});
let drawPlan;
let sunPatch = [];
canvas.addEventListener("sunpatch", event => {
  sunPatch = event.detail;
  drawPlan?.(pose);
});
let toWorld;
let projectPlan;
let pose;
let draft;
let drawing = false;
let stroke;
let strokePointer;
let markDrag;
let planDrag;
let orbitDrag;
let planOffset = [0, 0];
let planZoom = 1;
let planBearing = -.5;
let planElevation = Math.PI / 3;
let planIs3D = true;
let panning = false;
let orbiting = false;
let obstacles = [];
let obstacleKey;
let marking = false;
let furniturePointer;
let furnitureCorner;
const placeMark = document.querySelector("#place-mark");
const addActor = document.querySelector("#add-actor");
const markButton = document.querySelector("#mark-obstacle");
const deleteFurniture = document.querySelector("#delete-furniture");
const instructions = document.querySelector("#plan-instructions");
const tools = document.querySelector("#plan-tools");
const drawCurve = document.querySelector("#draw-curve");
const centerAim = document.querySelector("#center-aim");
const panPlan = document.querySelector("#pan-plan");
const planViewTools = panPlan.parentElement;
const planZoomTools = document.querySelector(".plan-zoom");
const furnitureTools = document.querySelector(".furniture-tools");
const furnitureSizing = document.querySelector("#furniture-sizing");
const furnitureSelection = document.querySelector("#furniture-selection");
const furnitureHeightInput = document.querySelector("#furniture-height");
const viewMode = document.querySelector("#plan-view-mode");
const orbitPlan = document.querySelector("#orbit-plan");
const planHelp = "Drag empty space to orbit. Shift-drag to pan.";

function setPlanView(is3D) {
  if (planIs3D === is3D) return;
  planIs3D = is3D;
  viewMode.textContent = planIs3D ? "3D view" : "Top view";
  viewMode.setAttribute("aria-pressed", String(planIs3D));
  orbitPlan.disabled = !planIs3D;
  setOrbiting(false);
  resetPlanView();
}

viewMode.addEventListener("click", () => {
  if (drawing) setDrawing(false);
  setPlanView(!planIs3D);
  instructions.textContent = planIs3D ? planHelp : "Drag a handle to move it. Shift-drag to pan.";
});

function setOrbiting(enabled) {
  orbiting = enabled;
  orbitDrag = undefined;
  orbitPlan.setAttribute("aria-pressed", String(enabled));
  canvas.classList.toggle("orbiting", enabled);
  if (enabled) instructions.textContent = "Drag to orbit the room.";
}

function setPanning(enabled) {
  panning = enabled;
  planDrag = undefined;
  panPlan.setAttribute("aria-pressed", String(enabled));
  canvas.classList.toggle("panning", enabled);
  if (enabled) instructions.textContent = "Drag the plan to move the view.";
}

function resetPlanView() {
  planOffset = [0, 0];
  planZoom = 1;
  planBearing = -.5;
  planElevation = Math.PI / 3;
  drawPlan?.(pose);
}

function zoomPlan(factor, event) {
  const anchor = event && toWorld?.(event);
  const zoom = Math.max(.35, Math.min(3, planZoom * factor));
  planZoom = zoom;
  if (anchor) {
    const projected = projectPlan(anchor);
    planOffset = canvasPoint(event).map((value, axis) => planOffset[axis] + value - projected[axis]);
  }
  drawPlan?.(pose);
}

panPlan.addEventListener("click", () => {
  const enabled = !panning;
  setDrawing(false);
  setPanning(enabled);
});
orbitPlan.addEventListener("click", () => {
  const enabled = !orbiting;
  setDrawing(false);
  setOrbiting(enabled);
});
canvas.addEventListener("wheel", event => {
  if (!event.ctrlKey || !toWorld) return;
  event.preventDefault();
  zoomPlan(Math.exp(-event.deltaY * (event.deltaMode === 1 ? .08 : .012)), event);
}, {passive: false});
let gestureScale = 1;
canvas.addEventListener("gesturestart", event => {
  event.preventDefault();
  gestureScale = 1;
});
canvas.addEventListener("gesturechange", event => {
  event.preventDefault();
  if (!(event.scale > 0)) return;
  zoomPlan(event.scale / gestureScale);
  gestureScale = event.scale;
});
document.querySelector("#zoom-plan-out").addEventListener("click", () => zoomPlan(1 / 1.25));
document.querySelector("#zoom-plan-in").addEventListener("click", () => zoomPlan(1.25));
document.querySelector("#reset-plan-view").addEventListener("click", resetPlanView);
canvas.addEventListener("keydown", event => {
  const offset = {ArrowLeft: [-30, 0], ArrowRight: [30, 0], ArrowUp: [0, -30], ArrowDown: [0, 30]}[event.key];
  if (!offset) return;
  event.preventDefault();
  planOffset = planOffset.map((value, axis) => value + offset[axis]);
  drawPlan?.(pose);
});

function setMarking(enabled) {
  marking = enabled;
  draft = undefined;
  furniturePointer = undefined;
  furnitureCorner = undefined;
  markButton.setAttribute("aria-pressed", String(enabled));
  instructions.textContent = enabled ? "Drag a box on the floor, or click two opposite corners."
    : planIs3D ? planHelp : "Drag a handle to move it. Shift-drag to pan.";
  drawPlan?.(pose);
}

function setDrawing(enabled) {
  setPanning(false);
  setOrbiting(false);
  setMarking(false);
  drawing = enabled;
  stroke = undefined;
  strokePointer = undefined;
  drawCurve.setAttribute("aria-pressed", String(enabled));
  drawCurve.textContent = enabled ? "Cancel path" : "Draw path";
  if (enabled) {
    setPlanView(false);
    instructions.textContent = "Top view · Drag a path up to 4 m. Release to play.";
    canvas.scrollIntoView({block: "nearest"});
  }
  drawPlan?.(pose);
}

function selectPlanMark(value) {
  setDrawing(false);
  placeMark.value = value;
  const selected = placeMark.selectedOptions[0];
  if (selected) instructions.textContent = `Click the plan to place ${selected.textContent.toLowerCase()}, or drag its handle.`;
}

function syncActorOptions(actors) {
  const actorOptions = [...placeMark.options].filter(option => /^\d+$/.test(option.value));
  for (const option of actorOptions.slice(Math.max(2, actors.length))) {
    if (option.value !== placeMark.value || Number(option.value) > actors.length) option.remove();
  }
  for (let index = actorOptions.length; index < actors.length; index++) {
    placeMark.add(new Option(`Actor ${index + 1}`, String(index)));
  }
  addActor.disabled = actors.filter(Boolean).length >= maxActors;
}

addActor.addEventListener("click", () => {
  if (!pose) return;
  const missing = pose.actors.findIndex(point => !point);
  const index = missing < 0 ? pose.actors.length : missing;
  if (index >= maxActors) return;
  if (![...placeMark.options].some(option => option.value === String(index))) {
    placeMark.add(new Option(`Actor ${index + 1}`, String(index)));
  }
  selectPlanMark(String(index));
});

function placeHandle(mark, point) {
  if (mark === "camera" || mark === "start" || mark === "end") {
    canvas.dispatchEvent(mark === "camera"
      ? new CustomEvent("choosecamera", {detail: point})
      : new CustomEvent("chooseendpoint", {detail: {which: mark, point}}));
    return;
  }
  const detail = mark === "aim" ? point : {index: Number(mark), point};
  canvas.dispatchEvent(new CustomEvent(mark === "aim" ? "chooseaim" : "chooseactor", {detail}));
}

function syncFurnitureSizing(selected = Number(furnitureSelection.value)) {
  furnitureSizing.hidden = obstacles.length === 0;
  furnitureSelection.replaceChildren(...obstacles.map((_, index) =>
    new Option(`Furniture ${index + 1}`, String(index))));
  if (!obstacles.length) return;
  furnitureSelection.selectedIndex = Math.max(0, Math.min(selected, obstacles.length - 1));
  furnitureHeightInput.value = furnitureHeight(obstacles[furnitureSelection.selectedIndex]);
}

function publishObstacles() {
  if (obstacleKey) {
    try { localStorage.setItem(obstacleKey, JSON.stringify(obstacles)); } catch {}
  }
  canvas.dispatchEvent(new CustomEvent("obstacleschange", {detail: obstacles.slice()}));
  drawPlan?.(pose);
}

furnitureSelection.addEventListener("change", () => {
  furnitureHeightInput.value = furnitureHeight(obstacles[furnitureSelection.selectedIndex]);
  drawPlan?.(pose);
});
furnitureHeightInput.addEventListener("input", () => {
  const item = obstacles[furnitureSelection.selectedIndex];
  if (!item) return;
  if (furnitureHeightInput.validity.valid && Number.isFinite(furnitureHeightInput.valueAsNumber)) {
    item.height = furnitureHeightInput.valueAsNumber;
    publishObstacles();
  }
});
furnitureHeightInput.addEventListener("change", () => {
  const item = obstacles[furnitureSelection.selectedIndex];
  if (item) furnitureHeightInput.value = furnitureHeight(item);
});
drawCurve.addEventListener("click", () => setDrawing(!drawing));
markButton.addEventListener("click", () => {
  const enabled = !marking;
  setDrawing(false);
  setMarking(enabled);
});
placeMark.addEventListener("change", () => selectPlanMark(placeMark.value));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && (drawing || panning || marking || orbiting)) setDrawing(false);
});
deleteFurniture.addEventListener("click", () => {
  const index = furnitureSelection.selectedIndex;
  if (index < 0 || index >= obstacles.length) return;
  obstacles.splice(index, 1);
  syncFurnitureSizing(index);
  publishObstacles();
  (obstacles.length ? furnitureSelection : markButton).focus();
});
canvas.addEventListener("shotmounted", () => {
  tools.hidden = false;
  drawCurve.disabled = centerAim.disabled = false;
  publishObstacles();
});
function shotHandles(shot) {
  if (!shot) return [];
  return [
    {mark: "camera", position: shot.center, height: shot.cameraHeight, label: "CAM"},
    {mark: "start", position: shot.from, height: shot.cameraHeight, label: "START"},
    {mark: "end", position: shot.to, height: shot.cameraHeight, label: "END"},
    {mark: "aim", position: [shot.tx, shot.tz], height: shot.aimHeight, label: "AIM"},
    ...shot.actors.flatMap((position, index) => position
      ? [{mark: String(index), position, height: 0, label: `A${index + 1}`}] : []),
  ];
}

function canvasPoint(event) {
  const box = canvas.getBoundingClientRect();
  return [(event.clientX - box.left) * canvas.width / box.width,
    (event.clientY - box.top) * canvas.height / box.height];
}

function draggedPoint(event, drag) {
  const point = toWorld(event, drag.height);
  return point.map((value, axis) => value + drag.position[axis] - drag.origin[axis]);
}

canvas.addEventListener("pointerdown", event => {
  if (!toWorld || (event.button !== 0 && event.button !== 2)) return;
  if (planDrag || orbitDrag || stroke || markDrag || furniturePointer != null) return;
  if (panning || event.shiftKey) {
    canvas.setPointerCapture(event.pointerId);
    planDrag = {pointer: event.pointerId, x: event.clientX, y: event.clientY, offset: planOffset};
    return;
  }
  if (event.button === 2 || event.altKey || orbiting) {
    if (planIs3D) beginOrbit(event, false);
    return;
  }
  if (!marking && document.querySelector("#viewport").hidden) return;
  const point = toWorld(event);
  if (drawing) {
    if (stroke) return;
    canvas.setPointerCapture(event.pointerId);
    strokePointer = event.pointerId;
    stroke = [toWorld(event, pose?.cameraHeight)];
    return;
  }
  if (!marking) {
    if (markDrag) return;
    const [x, y] = canvasPoint(event);
    const box = canvas.getBoundingClientRect();
    let closestDistance = 13;
    let hit;
    for (const handle of shotHandles(pose)) {
      const [px, py] = projectPlan(handle.position, handle.height);
      const actorTop = planIs3D && /^\d+$/.test(handle.mark)
        ? projectPlan(handle.position, standIn.eyeHeight)[1] : py;
      const closestY = Math.max(actorTop, Math.min(py, y));
      const distance = Math.hypot((px - x) * box.width / canvas.width, (closestY - y) * box.height / canvas.height);
      if (distance < closestDistance || (distance === closestDistance && handle.mark === placeMark.value)) {
        closestDistance = distance;
        hit = handle;
      }
    }
    if (hit != null) {
      canvas.setPointerCapture(event.pointerId);
      markDrag = {...hit, pointer: event.pointerId, origin: toWorld(event, hit.height), point: hit.position};
      return;
    }
    beginOrbit(event, true);
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  furniturePointer = event.pointerId;
  draft = [furnitureCorner || point, point];
});
canvas.addEventListener("contextmenu", event => event.preventDefault());

function beginOrbit(event, placeOnClick) {
  canvas.setPointerCapture(event.pointerId);
  orbitDrag = {pointer: event.pointerId, x: event.clientX, y: event.clientY,
    bearing: planBearing, elevation: planElevation, placeOnClick, moved: false};
}

canvas.addEventListener("pointermove", event => {
  if (planDrag?.pointer === event.pointerId) {
    const box = canvas.getBoundingClientRect();
    planOffset = [planDrag.offset[0] + (event.clientX - planDrag.x) * canvas.width / box.width,
      planDrag.offset[1] + (event.clientY - planDrag.y) * canvas.height / box.height];
    drawPlan?.(pose);
    return;
  }
  if (orbitDrag?.pointer === event.pointerId) {
    const dx = event.clientX - orbitDrag.x, dy = event.clientY - orbitDrag.y;
    orbitDrag.moved ||= Math.hypot(dx, dy) > 4;
    if (orbitDrag.moved && planIs3D) {
      planBearing = orbitDrag.bearing + dx * .012;
      planElevation = Math.max(.3, Math.min(Math.PI / 2 - .02, orbitDrag.elevation - dy * .009));
      drawPlan?.(pose);
    }
    return;
  }
  if (stroke && event.pointerId === strokePointer) {
    const point = toWorld(event, pose?.cameraHeight);
    const previous = stroke.at(-1);
    if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= .015) {
      if (stroke.length >= maxCurvePoints / 2 - 1) stroke = stroke.filter((_, index) => index % 2 === 0);
      stroke.push(point);
    }
    drawPlan?.(pose);
    return;
  }
  if (markDrag?.pointer === event.pointerId) {
    markDrag.point = draggedPoint(event, markDrag);
    if (markDrag.mark === "aim") {
      canvas.dispatchEvent(new CustomEvent("previewaim", {detail: markDrag.point}));
      return;
    }
    drawPlan?.(pose);
    return;
  }
  if (!draft || !toWorld || (furniturePointer != null && event.pointerId !== furniturePointer)) return;
  draft[1] = toWorld(event);
  drawPlan?.(pose);
});
canvas.addEventListener("pointerup", event => {
  if (planDrag?.pointer === event.pointerId) {
    planDrag = undefined;
    return;
  }
  if (orbitDrag?.pointer === event.pointerId) {
    const {moved, placeOnClick, x, y} = orbitDrag;
    orbitDrag = undefined;
    if (placeOnClick && !moved && Math.hypot(event.clientX - x, event.clientY - y) <= 4) {
      const mark = placeMark.value;
      const height = mark === "aim" ? pose?.aimHeight : /^\d+$/.test(mark) ? 0 : pose?.cameraHeight;
      placeHandle(mark, toWorld(event, height));
    }
    return;
  }
  if (stroke && event.pointerId === strokePointer) {
    const path = roundStroke([...stroke, toWorld(event, pose?.cameraHeight)]);
    setDrawing(false);
    if (!tracePath(path)) {
      instructions.textContent = "Draw a path between 1 cm and 4 m.";
      return;
    }
    canvas.dispatchEvent(new CustomEvent("drawcamera", {detail: path}));
    instructions.textContent = "Path set. Switch to 3D view to inspect its height.";
    return;
  }
  if (markDrag?.pointer === event.pointerId) {
    const drag = markDrag;
    const point = draggedPoint(event, drag);
    markDrag = undefined;
    if (Math.hypot(point[0] - drag.position[0], point[1] - drag.position[1]) > .005) placeHandle(drag.mark, point);
    if (drag.mark === "aim") canvas.dispatchEvent(new CustomEvent("previewaim"));
    drawPlan?.(pose);
    return;
  }
  if (!draft || !toWorld || event.pointerId !== furniturePointer) return;
  const a = draft[0], b = toWorld(event);
  const min = a.map((value, i) => Math.min(value, b[i]));
  const max = a.map((value, i) => Math.max(value, b[i]));
  const added = max.every((value, i) => value - min[i] >= .08);
  if (added) {
    let number = obstacles.length + 1;
    while (obstacles.some(item => item.name === `marked furniture ${number}`)) number++;
    obstacles.push({min, max, height: defaultFurnitureHeight, name: `marked furniture ${number}`});
    setMarking(false);
    syncFurnitureSizing(obstacles.length - 1);
    publishObstacles();
    instructions.textContent = "Furniture added. Set its height to match the object.";
  } else {
    furnitureCorner = a;
    furniturePointer = undefined;
    instructions.textContent = "Click the opposite corner, at least 8 cm away on both sides.";
  }
});
canvas.addEventListener("pointercancel", event => {
  if (planDrag?.pointer === event.pointerId) planDrag = undefined;
  if (orbitDrag?.pointer === event.pointerId) orbitDrag = undefined;
  if (markDrag?.pointer === event.pointerId) {
    const wasAim = markDrag.mark === "aim";
    markDrag = undefined;
    if (wasAim) canvas.dispatchEvent(new CustomEvent("previewaim"));
    drawPlan?.(pose);
  } else if (event.pointerId === strokePointer || event.pointerId === furniturePointer) setDrawing(false);
});
document.querySelector("#viewport").addEventListener("shotpose", event => {
  if (placeMark.options.length !== 4 + event.detail.actors.length || !pose) {
    syncActorOptions(event.detail.actors);
  }
  addActor.disabled = event.detail.actors.filter(Boolean).length >= maxActors;
  pose = event.detail;
  const width = `${(2 * pose.rigRadius).toFixed(2)} m rig width · drawn to scale`;
  if (rigWidth.textContent !== width) rigWidth.textContent = width;
  rigWidth.hidden = false;
  drawPlan?.(pose);
});
const capture = document.querySelector("#capture");


function element(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

const shortlistPanel = document.querySelector("#shortlist");
let shortlist = [];

function renderShortlist() {
  shortlistPanel.hidden = shortlist.length === 0;
  shortlistPanel.querySelector("ul").replaceChildren(...shortlist.map(item => {
    const caption = spaceLabel(item.caption);
    const entry = element("li", [item.label, caption].filter(Boolean).join(" · ") + " ");
    const inspect = element("button", "Inspect");
    const remove = element("button", "Remove");
    inspect.addEventListener("click", () => inspectRoom({name: item.label}, item.modelId));
    remove.addEventListener("click", () => {
      shortlist = shortlist.filter(saved => saved.modelId !== item.modelId);
      renderShortlist();
    });
    entry.append(inspect, remove);
    return entry;
  }));
}

function card(row, readiness = {}) {
  const article = element("article", "");
  article.tabIndex = -1;
  article.dataset.propertyId = String(row.property_id);
  article.append(element("h3", row.name || row.street),
    element("p", [row.street, row.city, row.state].filter(Boolean).join(", ")));
  const evidence = cleanPropertyDescription(row.evidence, row.name, row.street);
  const description = element("p", "");
  description.className = "property-description";
  article.append(description);
  if (evidence.length > 155) {
    const details = document.createElement("details");
    details.className = "property-details";
    details.append(element("summary", "Full description"), element("p", evidence));
    article.append(details);
  }
  function showDescription(area) {
    const isLong = evidence.length > 155;
    const atWord = evidence.lastIndexOf(" ", 150);
    const excerpt = isLong ? evidence.slice(0, atWord > 80 ? atWord : 150).replace(/[\s.…,;:]+$/, "") + "…" : evidence;
    description.textContent = [excerpt, area && listedArea(excerpt) !== area ? `Listed area: ${area}.` : ""]
      .filter(Boolean).join(excerpt && !/[.!?…]$/.test(excerpt) ? " · " : " ");
    description.hidden = !description.textContent;
  }
  showDescription("");
  const models = Object.entries(row.models);
  if (!models.length) {
    article.append(element("p", "No linked Matterport scan."));
    return article;
  }
  const scans = element("select", "");
  scans.setAttribute("aria-label", "Scan for " + (row.name || row.street));
  for (const [index, [id, caption]] of models.entries()) {
    const name = spaceLabel(caption);
    const option = new Option(name || `Space ${index + 1}`, id);
    scans.add(option);
    if (!name && readiness[id]?.roomCount) {
      fetch("/api/rooms?" + new URLSearchParams({model: id}))
        .then(response => response.ok ? response.json() : [])
        .then(rooms => { option.text = capturedSpaceLabel(rooms) || option.text; })
        .catch(() => {});
    }
  }
  const scanStatus = element("p", "");
  scanStatus.className = "scan-status";
  scanStatus.id = `scan-status-${row.property_id}`;
  scans.setAttribute("aria-describedby", scanStatus.id);
  const updateScanStatus = () => {
    const scan = readiness[scans.value];
    if (scan?.alignedRoomCount) {
      const count = scan.alignedRoomCount;
      scanStatus.textContent = count === 1 ? "1 aligned room" : `${count} aligned rooms`;
    } else {
      scanStatus.textContent = !scan ? "Scan status unavailable"
        : scan.meshAvailable ? "Alignment review pending"
        : scan.roomCount ? "Room outline available"
        : "Room geometry pending";
    }
    showDescription(listedArea(row.models[scans.value]));
  };
  scans.addEventListener("change", updateScanStatus);
  updateScanStatus();
  const inspect = element("button", "Inspect room");
  inspect.addEventListener("click", () => {
    void inspectRoom(row, scans.value);
    roomTitle.focus();
  });
  const pin = element("button", "Shortlist scan");
  pin.addEventListener("click", () => {
    const modelId = scans.value;
    if (!shortlist.some(item => item.modelId === modelId)) {
      if (shortlist.length >= 30) {
        status.textContent = "Remove a scan before adding another to the shortlist.";
        return;
      }
      shortlist.push({modelId, label: row.name || row.street, caption: scans.selectedOptions[0].text});
      renderShortlist();
    }
    shortlistPanel.open = true;
    void inspectRoom(row, modelId);
    roomTitle.focus();
  });
  const actions = element("div", "");
  actions.className = "location-actions";
  actions.append(inspect, pin);
  const controls = element("div", "");
  controls.className = "location-controls";
  controls.append(scans, scanStatus, actions);
  article.append(controls);
  return article;
}

const measuredRoom = document.querySelector("#measured-room");
const measuredForm = measuredRoom.querySelector("form");
const measuredStatus = measuredForm.querySelector('[role="status"]');

function enableMeasuredImport(row, model, signal) {
  measuredRoom.hidden = false;
  measuredRoom.open = false;
  measuredForm.reset();
  measuredStatus.textContent = "";
  const button = measuredForm.querySelector("button");
  button.disabled = false;
  measuredForm.onsubmit = async event => {
    event.preventDefault();
    if (signal.aborted) return;
    button.disabled = true;
    try {
      const inputs = new FormData(measuredForm);
      const file = inputs.get("plan");
      if (file.size > 90_000) throw Error("Use a room outline JSON file under 90 KB.");
      const plan = JSON.parse(await file.text());
      const response = await fetch("/api/import-measured-room", {method: "POST",
        headers: {"Content-Type": "application/json"}, signal,
        body: JSON.stringify({model, room: inputs.get("room"), plan})});
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      if (!signal.aborted) await inspectRoom(row, model, result.room);
    } catch (error) {
      if (!signal.aborted) measuredStatus.textContent = error.message;
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  };
}

async function inspectRoom(row, model, roomId, proposedShot, autoGeometry = true) {
  const priorLocation = activeScan === model ? activeLocation : "";
  if (activeScan !== model) activePropertyId = undefined;
  if (row.property_id != null) activePropertyId = String(row.property_id);
  activeScan = model;
  updateActiveProperty();
  delete workspace.dataset.browse;
  roomPanel.hidden = false;
  roomRequest?.abort();
  measuredRoom.hidden = true;
  uploadMesh.hidden = true;
  importMesh.hidden = true;
  importMesh.disabled = retryMesh.disabled = false;
  selectedRoom = undefined;
  closeMesh();
  roomPicker.hidden = true;
  const request = new AbortController();
  roomRequest = request;
  roomTitle.textContent = row.name || row.street || "Room plan";
  roomGeometry.hidden = true;
  showLocation(row.location || (row.city || row.street ? propertyLabel(row) : priorLocation));
  if (!activeLocation) {
    fetch("/api/scan-property?" + new URLSearchParams({model}), {signal: request.signal})
      .then(response => response.ok ? response.json() : null)
      .then(result => {
        if (!request.signal.aborted && result?.property) showLocation(propertyLabel(result.property));
      }).catch(() => {});
  }
  canvas.hidden = capture.hidden = rigWidth.hidden = planViewTools.hidden =
    planZoomTools.hidden = furnitureTools.hidden = instructions.hidden = true;
  resetPlanView();
  drawPlan = toWorld = projectPlan = pose = undefined;
  markDrag = undefined;
  tools.hidden = true;
  drawCurve.disabled = centerAim.disabled = addActor.disabled = true;
  obstacles = [];
  obstacleKey = undefined;
  selectPlanMark("camera");
  roomStatus.textContent = "Looking for imported rooms…";
  try {
    const params = new URLSearchParams({model});
    const availableRooms = await fetch("/api/rooms?" + params, {signal: request.signal}).then(response =>
      response.ok ? response.json() : []);
    if (request.signal.aborted) return;
    const choices = availableRooms.filter(room => !isVoidRoom(room.label));
    const actualLabel = capturedSpaceLabel(choices);
    if (actualLabel) {
      for (const option of results.querySelectorAll("select option")) {
        if (option.value === model && /^Space \d+$/.test(option.text)) option.text = actualLabel;
      }
    }
    enableMeasuredImport(row, model, request.signal);
    const caption = row.models?.[model];
    const names = roomNames(choices, caption);
    if (choices.length > 1) {
      const selected = choices.findIndex(choice => choice.id === (roomId ?? choices[0].id));
      roomOptions.replaceChildren(...names.map((name, index) => new Option(name, String(index))));
      roomOptions.selectedIndex = Math.max(selected, 0);
      roomOptions.onchange = () => inspectRoom(row, model, choices[roomOptions.selectedIndex].id);
      roomPicker.hidden = false;
    }
    const requestedRoom = roomId ?? choices[0]?.id;
    if (requestedRoom) params.set("room", requestedRoom);
    const response = await fetch("/api/room?" + params, {signal: request.signal});
    const data = await response.json();
    if (request.signal.aborted) return;
    if (response.ok && isVoidRoom(data.label)) {
      roomStatus.textContent = "This scan has no selectable room at that link.";
      return false;
    }
    if (!response.ok) {
      const scan = element("a", "Open Matterport scan");
      scan.href = "https://my.matterport.com/show/?m=" + encodeURIComponent(model);
      scan.target = "_blank";
      scan.rel = "noopener";
      roomStatus.replaceChildren(document.createTextNode(data.error + " "), scan);
      if (response.status === 404 && choices.length === 0) {
        const available = await fetch("/api/room-import-status", {signal: request.signal})
          .then(reply => reply.ok ? reply.json() : {}).catch(() => ({}));
        if (available.configured && !request.signal.aborted) {
          const importButton = element("button", "Import room geometry");
          importButton.type = "button";
          const importGeometry = async () => {
            importButton.disabled = true;
            roomStatus.replaceChildren(document.createTextNode("Importing Matterport room geometry…"));
            try {
              const reply = await fetch("/api/import-room", {method: "POST",
                headers: {"Content-Type": "application/json"}, body: JSON.stringify({model}),
                signal: request.signal});
              const result = await reply.json();
              if (request.signal.aborted) return;
              if (!reply.ok) throw Error(result.error);
              return await inspectRoom(row, model, roomId, proposedShot, false);
            } catch (error) {
              if (!request.signal.aborted) {
                importButton.disabled = false;
                roomStatus.replaceChildren(document.createTextNode(error.message + " "), scan, " ", importButton);
              }
            }
          };
          importButton.addEventListener("click", importGeometry);
          if (autoGeometry) return await importGeometry();
          roomStatus.append(" ", importButton);
        } else if (!request.signal.aborted) {
          roomStatus.prepend(document.createTextNode(
            "Start the server with Matterport credentials to import this scan automatically. "));
        }
      }
      return;
    }
    obstacleKey = "scout-obstacles:" + roomKey(data);
    obstacles = proposedShot?.obstacles ? structuredClone(proposedShot.obstacles) : loadObstacles(data);
    const roomIndex = choices.findIndex(choice => choice.id === (data.roomId ?? null));
    const name = names[roomIndex] || roomName(data.label, data.roomId, caption);
    roomTitle.textContent = namedRoomFromOutline(name, data.outline);
    if (!roomPicker.hidden && roomIndex >= 0) roomOptions.options[roomIndex].text = roomTitle.textContent;
    showLocation(activeLocation);
    renderRoom(data);
    if (data.capturePlan) {
      const image = capture.querySelector("img");
      image.onload = () => { if (!request.signal.aborted) capture.hidden = false; };
      image.src = data.capturePlan;
    }
    selectedRoom = proposedShot ? {...data, proposedShot} : data;
    await openMesh(selectedRoom, request.signal);
    if (!request.signal.aborted && !retryMesh.hidden) {
      uploadMesh.hidden = false;
      importMesh.hidden = !data.matterpakDownloadConfigured;
      if (data.matterpakDownloadConfigured && !data.matterpakAvailable) {
        await prepareMatterPak(selectedRoom, request);
      }
    }
    if (request.signal.aborted || document.querySelector("#viewport").hidden) return false;
    const url = new URL(location.href);
    url.searchParams.set("model", model);
    if (data.roomId) url.searchParams.set("room", data.roomId);
    else url.searchParams.delete("room");
    url.searchParams.set("name", data.label || row.name || row.street || model);
    history.replaceState(null, "", url);
    return true;
  } catch (error) {
    if (!request.signal.aborted) roomStatus.textContent = "Could not load the room export.";
  }
}

function renderRoom(room) {
  markDrag = undefined;
  const points = room.outline;
  if (!Array.isArray(points) || points.length < 3 ||
      points.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
    roomStatus.textContent = "This room export has an invalid outline.";
    return;
  }
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  const width = Math.max(...xs) - left, depth = Math.max(...ys) - top;
  if (width <= 0 || depth <= 0) {
    roomStatus.textContent = "This room export has a degenerate outline.";
    return;
  }
  const fitScale = Math.min((canvas.width - 120) / width, (canvas.height - 120) / depth);
  const center = [left + width / 2, top + depth / 2];
  const wallHeight = Number.isFinite(room.height) && room.height > 0 ? room.height : 2.5;
  const projection = () => planProjection({
    center,
    origin: [canvas.width / 2 + planOffset[0], canvas.height / 2 + planOffset[1] + (planIs3D ? 45 : 0)],
    scale: fitScale * planZoom * (planIs3D ? .76 : 1),
    bearing: planBearing * (planIs3D ? 1 : 0),
    elevation: planIs3D ? planElevation : Math.PI / 2,
  });
  const context = canvas.getContext("2d");
  canvas.hidden = planViewTools.hidden = planZoomTools.hidden = furnitureTools.hidden = instructions.hidden = false;
  syncFurnitureSizing(0);
  toWorld = (event, height = 0) => projection().unproject(canvasPoint(event), height);
  projectPlan = (point, height) => projection().project(point, height);
  drawPlan = pose => {
    const view = projection();
    const scale = fitScale * planZoom * (planIs3D ? .76 : 1);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.transform(...view.floorTransform);
    const coords = ([x, z]) => [x - center[0], z - center[1]];
    context.beginPath();
    points.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
    context.closePath();
    context.fillStyle = "#354844";
    context.fill();
    context.strokeStyle = "#83b3a4";
    context.lineWidth = 3 / scale;
    context.stroke();
    context.save();
    context.clip();
    context.beginPath();
    for (const triangle of sunPatch) {
      triangle.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
      context.closePath();
    }
    context.fillStyle = "#ffcf6b";
    context.fill();
    context.restore();
    for (const [a, b] of [...obstacles.map(obstacle => [obstacle.min, obstacle.max]), ...(draft ? [draft] : [])]) {
      const [x, z] = coords(a), [endX, endZ] = coords(b);
      context.fillStyle = "#a35449a8";
      context.strokeStyle = "#ff9c92";
      context.lineWidth = 2 / scale;
      context.fillRect(x, z, endX - x, endZ - z);
      context.strokeRect(x, z, endX - x, endZ - z);
    }
    if (pose) {
      const footprint = pose.pathPoints || [pose.from, pose.to];
      const diameter = 2 * pose.rigRadius;
      const color = document.querySelector("#clearance").dataset.result === "fail"
        ? "#ff8b8266" : "#f1b87b66";
      context.save();
      context.beginPath();
      if (footprint.every(point => point[0] === footprint[0][0] && point[1] === footprint[0][1])) {
        context.arc(...coords(footprint[0]), diameter / 2, 0, 2 * Math.PI);
        context.fillStyle = color;
        context.fill();
      } else {
        footprint.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
        context.strokeStyle = color;
        context.lineWidth = diameter;
        context.lineJoin = context.lineCap = "round";
        context.stroke();
      }
      context.restore();
    }
    context.restore();
    if (planIs3D) {
      context.save();
      for (let index = 0; index < points.length; index++) {
        const a = points[index], b = points[(index + 1) % points.length];
        const corners = [view.project(a), view.project(b), view.project(b, wallHeight), view.project(a, wallHeight)];
        context.beginPath();
        corners.forEach((point, i) => context[i ? "lineTo" : "moveTo"](...point));
        context.closePath();
        context.fillStyle = "#6a8c801b";
        context.strokeStyle = "#83b3a454";
        context.lineWidth = 1;
        context.fill();
        context.stroke();
      }
      for (const [itemIndex, item] of obstacles.entries()) {
        const height = furnitureHeight(item);
        if (!height) continue;
        const [x, z] = item.min, [maxX, maxZ] = item.max;
        const corners = [[x, z], [maxX, z], [maxX, maxZ], [x, maxZ]];
        const floor = corners.map(point => view.project(point));
        const top = corners.map(point => view.project(point, height));
        for (let i = 0; i < top.length; i++) {
          const next = (i + 1) % top.length;
          context.beginPath();
          [floor[i], floor[next], top[next], top[i]].forEach((point, index) =>
            context[index ? "lineTo" : "moveTo"](...point));
          context.closePath();
          context.fillStyle = "#b6644b55";
          context.fill();
        }
        context.beginPath();
        top.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...point));
        context.closePath();
        context.fillStyle = "#b6644baa";
        context.strokeStyle = itemIndex === furnitureSelection.selectedIndex ? "#f3b990" : "#ff9c92";
        context.lineWidth = itemIndex === furnitureSelection.selectedIndex ? 2 : 1;
        context.fill();
        context.stroke();
      }
      context.restore();
    }
    if (stroke || pose) {
      const path = stroke || pose.pathPoints || [pose.from, pose.to];
      const height = pose?.cameraHeight ?? 0;
      context.beginPath();
      path.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...view.project(point, height)));
      context.strokeStyle = !stroke && document.querySelector("#clearance").dataset.result === "fail"
        ? "#ff8b82" : "#f1b87b";
      context.lineWidth = stroke ? 4 : 3;
      context.lineJoin = context.lineCap = "round";
      context.stroke();
      if (planIs3D && pose) {
        context.beginPath();
        for (const point of [path[0], path.at(-1)]) {
          context.moveTo(...view.project(point));
          context.lineTo(...view.project(point, height));
        }
        context.strokeStyle = "#f1b87b7d";
        context.lineWidth = 1;
        context.stroke();
      }
    }
    if (pose) {
      const handles = shotHandles(pose);
      const aim = markDrag?.mark === "aim" ? markDrag.point : [pose.tx, pose.tz];
      const movingEye = view.project([pose.x, pose.z], pose.cameraHeight);
      context.beginPath();
      context.moveTo(...movingEye);
      context.lineTo(...view.project(aim, pose.aimHeight));
      context.setLineDash([6, 6]);
      context.lineWidth = 2;
      context.strokeStyle = "#f9ddae";
      context.stroke();
      context.setLineDash([]);
      for (const handle of handles) {
        const point = markDrag?.mark === handle.mark ? markDrag.point : handle.position;
        const [x, y] = view.project(point, handle.height);
        const selected = handle.mark === placeMark.value;
        const actor = /^\d+$/.test(handle.mark);
        if (planIs3D && actor) {
          context.save();
          const color = standIn.colors[Number(handle.mark) % standIn.colors.length];
          context.fillStyle = context.strokeStyle = color;
          context.lineWidth = 2 * standIn.bodyRadius * scale;
          context.lineCap = "round";
          context.beginPath();
          context.moveTo(...view.project(point, standIn.bodyCenter - standIn.bodyLength / 2));
          context.lineTo(...view.project(point, standIn.bodyCenter + standIn.bodyLength / 2));
          context.stroke();
          context.beginPath();
          context.arc(...view.project(point, standIn.eyeHeight), standIn.headRadius * scale, 0, 2 * Math.PI);
          context.fill();
          context.restore();
        }
        context.fillStyle = actor ? "#a1d1e3" : "#f9ddae";
        context.strokeStyle = context.fillStyle;
        context.font = "bold 15px system-ui";
        const labelRight = handle.mark !== "start";
        context.textAlign = labelRight ? "left" : "right";
        const labelY = planIs3D && actor ? view.project(point, standIn.eyeHeight)[1] : y;
        context.fillText(handle.label, x + (labelRight ? 10 : -10), labelY - 9);
        if (handle.mark === "aim") context.strokeRect(x - 6, y - 6, 12, 12);
        else {
          context.beginPath();
          context.arc(x, y, selected ? 8 : 6, 0, 2 * Math.PI);
          context.fill();
        }
      }
    }
  };
  drawPlan();
  const source = room.geometrySource || "Imported outline";
  const area = outlineMeasurements(points).area;
  roomGeometry.textContent = source + " · " + width.toFixed(2) + " m × " +
    depth.toFixed(2) + " m bounds · " + area.toFixed(1) +
    " m² outline area (" + Math.round(area * 10.7639104).toLocaleString() + " sq ft)";
  roomGeometry.hidden = false;
  roomStatus.textContent = "";
}

const moreLocations = document.querySelector("#more-locations");
let nextLocationPage;
let searchRequest;

function resetLocationSearch(city) {
  searchRequest?.abort();
  delete workspace.dataset.searched;
  delete workspace.dataset.browse;
  nextLocationPage = undefined;
  moreLocations.hidden = true;
  results.replaceChildren();
  resetLocationMap(city);
}

async function loadLocationPage(filters) {
  workspace.dataset.searched = "";
  searchRequest?.abort();
  const request = new AbortController();
  searchRequest = request;
  const button = form.querySelector("button");
  button.disabled = moreLocations.disabled = true;
  status.textContent = "Searching the local catalog…";
  try {
    const response = await fetch("/api/locations?" + filters, {signal: request.signal});
    const data = await response.json();
    if (request.signal.aborted) return;
    if (!response.ok) throw new Error(data.error || "Search API failed");
    const {rows, mode, scanReadiness, next_offset: offset} = data;
    const cards = rows.map(row => card(row, scanReadiness));
    results.append(...cards);
    if (!activeLocation && activeScan) {
      const matches = rows.filter(row => Object.hasOwn(row.models, activeScan));
      if (matches.length === 1) showLocation(propertyLabel(matches[0]));
    }
    updateActiveProperty();
    void addMapLocations(rows, cards);
    nextLocationPage = undefined;
    if (Number.isSafeInteger(offset) && offset > Number(filters.get("offset") ?? 0)) {
      nextLocationPage = new URLSearchParams(filters);
      nextLocationPage.set("offset", String(offset));
    }
    moreLocations.hidden = !nextLocationPage;
    const count = results.children.length;
    const coverage = mode === "addresses" ? " · CoStar addresses and scan links only" : "";
    status.textContent = (count ? count + " property matches shown" : "No matching properties.") + coverage;
  } catch (error) {
    if (!request.signal.aborted) status.textContent = error.message;
  } finally {
    if (searchRequest === request) button.disabled = moreLocations.disabled = false;
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const filters = new URLSearchParams(new FormData(form));
  const browsing = Object.hasOwn(workspace.dataset, "browse");
  resetLocationSearch(filters.get("city"));
  if (browsing) workspace.dataset.browse = "";
  void loadLocationPage(filters);
});
document.querySelector("#location-map-city").addEventListener("change", event => {
  form.elements.city.value = event.target.value;
  form.requestSubmit();
});
moreLocations.addEventListener("click", () => {
  if (nextLocationPage) void loadLocationPage(nextLocationPage);
});

const restore = new URLSearchParams(location.search);
const requestedModel = restore.get("model");


const comparison = document.querySelector("#compare-form");
comparison.addEventListener("submit", async event => {
  event.preventDefault();
  const inputs = new FormData(comparison);
  const feedback = document.querySelector("#compare-status");
  const output = document.querySelector("#compare-results");
  const button = comparison.querySelector("button");
  button.disabled = true;
  feedback.textContent = "Checking imported room geometry…";
  output.replaceChildren();
  try {
    const minimumTravel = Number(inputs.get("minimum-travel"));
    const targetTravel = inputs.get("move") === "static" ? 0 : Number(inputs.get("slide"));
    if (minimumTravel > targetTravel) {
      feedback.textContent = "Minimum travel must be at or below the target travel.";
      return;
    }
    const response = await fetch("/api/imported-rooms");
    if (!response.ok) throw new Error("Cannot load imported rooms.");
    const imported = await response.json();
    const scoped = inputs.has("shortlisted");
    const entries = scoped ? shortlist.slice() : [];
    if (scoped && !entries.length) {
      feedback.textContent = "Shortlist a scan from CoStar search to compare it here.";
      return;
    }
    const models = new Set(entries.map(item => item.modelId));
    const rooms = scoped ? imported.filter(room => models.has(room.modelId)) : imported;
    const importedModels = new Set(rooms.map(room => room.modelId));
    for (const entry of entries) {
      if (importedModels.has(entry.modelId)) continue;
      const card = element("article", "");
      card.append(element("h3", [entry.label, spaceLabel(entry.caption)].filter(Boolean).join(" · ")),
        element("p", "Room outline needed before shot checks."));
      const open = element("button", "Inspect scan");
      open.addEventListener("click", () => inspectRoom({name: entry.label}, entry.modelId));
      card.append(open);
      output.append(card);
    }
    const ranked = await compareCapturedRooms(rooms, Number(inputs.get("lens")),
      targetTravel, inputs.get("move"), inputs.has("sightlines"), undefined,
      {sensorWidthMm: Number(inputs.get("sensor")), cameraHeight: Number(inputs.get("height")), rigRadius: Number(inputs.get("rig"))});
    feedback.textContent = ranked.length
      ? "Same lens, sensor width, camera height, rig radius, and requested travel. Each room uses its own actor marks. Includes saved furniture marks. Check each result for sightline coverage. Unmarked furniture remains unverified."
      : scoped ? "None of the shortlisted scans has an imported outline." : "Import a Matterport room to begin.";
    for (const item of ranked) {
      const card = element("article", "");
      const label = roomName(item.room.label, item.room.roomId);
      card.append(element("h3", label), element("p", item.reason));
      if (item.setup) card.append(element("p",
        Math.floor(item.clearanceMargin * 100) + " cm beyond the rig radius · " +
        Math.floor(item.framingMargin * 100) + "% frame margin at the tightest sample"));
      const fallback = item.setup && item.length < minimumTravel;
      if (fallback) card.append(element("p", "Below the " + minimumTravel + " m minimum."));
      const open = element("button", item.setup ? (fallback ? "Preview shorter fallback" : "Preview compared shot") : "Open room");
      open.addEventListener("click", () =>
        inspectRoom({name: label}, item.room.modelId, item.room.roomId, item.setup));
      card.append(open);
      output.append(card);
    }
  } catch {
    feedback.textContent = "Could not compare the imported rooms.";
  } finally {
    button.disabled = false;
  }
});

const agentForm = document.querySelector("#agent-form");
const agentResult = document.querySelector("#agent-result");
const agentEvidence = document.querySelector("#agent-evidence");
const agentActivity = document.querySelector("#agent-activity");
const projectForm = document.querySelector("#project-form");
const projectList = document.querySelector("#project-list");
const projectStatus = document.querySelector("#project-status");
const projectHistory = document.querySelector("#project-history");
const openProject = document.querySelector("#open-project");
const deleteProjectButton = document.querySelector("#delete-project");
const deleteConfirmation = document.querySelector("#delete-project-confirmation");
const deleteMessage = document.querySelector("#delete-project-message");
const confirmDelete = document.querySelector("#confirm-delete-project");
let pendingDeleteId;
let projectId;
let projectLocked = false;
let revisionHistory = [];

function setProjectLink(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("project", id);
  else url.searchParams.delete("project");
  history.replaceState(null, "", url);
}

function refreshProjects() {
  projectList.replaceChildren(new Option("Choose a project", ""));
  for (const project of readProjects().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    projectList.add(new Option(project.title, project.id));
  }
  projectList.value = projectId || "";
  updateDeleteAction();
}

function updateDeleteAction() {
  pendingDeleteId = undefined;
  deleteConfirmation.hidden = true;
  deleteProjectButton.disabled = !projectList.value;
}

projectList.addEventListener("change", updateDeleteAction);
deleteProjectButton.addEventListener("click", () => {
  if (projectLocked || !projectList.value) return;
  pendingDeleteId = projectList.value;
  deleteMessage.textContent = `Delete “${projectList.selectedOptions[0].textContent}” from this browser?`;
  deleteConfirmation.hidden = false;
  document.querySelector("#cancel-delete-project").focus();
});
document.querySelector("#cancel-delete-project").addEventListener("click", () => {
  updateDeleteAction();
  deleteProjectButton.focus();
});
confirmDelete.addEventListener("click", () => {
  if (projectLocked || !pendingDeleteId) return;
  try {
    deleteProject(pendingDeleteId);
    if (projectId === pendingDeleteId) {
      projectId = undefined;
      setProjectLink(null);
    }
    refreshProjects();
    projectList.focus();
    projectStatus.textContent = "Project deleted.";
  } catch {
    projectStatus.textContent = "Could not delete the project.";
  }
});

function renderHistory() {
  projectHistory.hidden = !revisionHistory.length;
  projectHistory.querySelector("ol").replaceChildren(...revisionHistory.map(item => {
    const entry = element("li", item.brief + " · " + roomName(item.selection?.label, item.selection?.roomId));
    const restore = element("button", "Open revision");
    restore.disabled = projectLocked;
    restore.addEventListener("click", () => {
      if (!projectLocked) restoreSelection(item.selection);
    });
    entry.append(restore);
    if (item.activity?.length) {
      const evidence = element("details", "");
      const steps = element("ul", "");
      steps.append(...item.activity.map(text => element("li", text)));
      evidence.append(element("summary", "Evidence and tool activity"), steps);
      entry.append(evidence);
    }
    return entry;
  }));
}

function selectionSnapshot() {
  if (!selectedRoom) return null;
  const {modelId, roomId, label} = selectedRoom;
  return {modelId, roomId, label, location: activeLocation || undefined, shot: currentShot()};
}

async function restoreSelection(selection) {
  if (selection) return inspectRoom({name: selection.label || selection.modelId, location: selection.location},
    selection.modelId, selection.roomId, selection.shot);
  roomPanel.hidden = true;
  roomRequest?.abort();
  activeScan = activePropertyId = undefined;
  updateActiveProperty();
  showLocation();
  roomGeometry.hidden = true;
  measuredRoom.hidden = true;
  uploadMesh.hidden = true;
  importMesh.hidden = true;
  importMesh.disabled = retryMesh.disabled = false;
  selectedRoom = undefined;
  closeMesh();
  roomPicker.hidden = canvas.hidden = capture.hidden = tools.hidden = rigWidth.hidden =
    planViewTools.hidden = planZoomTools.hidden = furnitureTools.hidden = instructions.hidden = true;
  setSidebarVisible(true);
  drawPlan = toWorld = projectPlan = pose = undefined;
  markDrag = undefined;
  setDrawing(false);
  document.querySelector("#room-title").textContent = "Room plan";
  roomStatus.textContent = "";
  const url = new URL(location.href);
  for (const field of ["model", "room", "name"]) url.searchParams.delete(field);
  history.replaceState(null, "", url);
  return true;
}

async function openCheckedProposal(room, setup, requireCapture = false) {
  const previous = selectionSnapshot();
  const opening = inspectRoom({name: room.label || room.modelId}, room.modelId, room.roomId, setup);
  const request = roomRequest;
  const opened = await opening;
  if (request !== roomRequest || request.signal.aborted)
    throw Error("The room changed while the proposal was opening. Your selection was kept.");
  const missingSightlines = opened && setup.requireSightlines && !currentShotCanCheckSightlines();
  const missingCapture = opened && requireCapture && !retryMesh.hidden;
  if (!opened || missingSightlines || missingCapture) {
    await restoreSelection(previous);
    const error = Error(missingSightlines ? "The proposal requires an aligned MatterPak, which the editor could not load."
      : missingCapture ? "The MatterPak was prepared, but the captured 3D scene could not load."
      : "Could not open the proposed shot.");
    if (requireCapture) error.code = "capture-unavailable";
    throw error;
  }
}

function agentSettings() {
  const inputs = new FormData(agentForm);
  return {brief: inputs.get("brief"), lens: inputs.get("lens"), lockedMove: inputs.get("locked-move"), targetTravel: inputs.get("target-travel"), minimumTravel: inputs.get("minimum-travel"),
    shortlistOnly: inputs.has("shortlist-only"), lockRoom: inputs.has("lock-room"), requireSightlines: inputs.has("require-sightlines"), apply: inputs.has("apply")};
}

function setAgentSettings(settings = {}) {
  clearBriefReview();
  agentForm.elements["import-outlines"].checked = false;
  agentForm.elements.brief.value = settings.brief ?? "";
  agentForm.elements.lens.value = settings.lens ?? "";
  agentForm.elements["locked-move"].value = settings.lockedMove ?? "";
  agentForm.elements["target-travel"].value = settings.targetTravel ?? "";
  agentForm.elements["minimum-travel"].value = settings.minimumTravel ?? "";
  agentForm.elements["shortlist-only"].checked = settings.shortlistOnly === true;
  agentForm.elements["lock-room"].checked = settings.lockRoom === true;
  agentForm.elements["require-sightlines"].checked = settings.requireSightlines === true;
  agentForm.elements.apply.checked = settings.apply !== false;
}

projectForm.addEventListener("submit", event => {
  event.preventDefault();
  if (projectLocked) return;
  const title = projectForm.elements.title.value.trim();
  if (!title) return;
  try {
    const project = writeProject({
      id: projectId || crypto.randomUUID(), title, settings: agentSettings(),
      query: form.elements.q.value, filters: {city: form.elements.city.value, category: form.elements.category.value, linked: form.elements.linked.checked, imported: form.elements.imported.checked}, selection: selectionSnapshot(),
      revisions: revisionHistory, shortlist,
    });
    projectId = project.id;
    setProjectLink(projectId);
    refreshProjects();
    projectStatus.textContent = "Saved " + title + ".";
  } catch {
    projectStatus.textContent = "Could not save the project in this browser.";
  }
});

document.querySelector("#new-project").addEventListener("click", () => {
  if (projectLocked) return;
  projectId = undefined;
  setProjectLink(null);
  projectForm.reset();
  projectList.value = "";
  updateDeleteAction();
  revisionHistory = [];
  shortlist = [];
  renderShortlist();
  previousRoom = undefined;
  undoAgent.hidden = true;
  setAgentSettings();
  renderHistory();
  agentEvidence.replaceChildren();
  agentActivity.replaceChildren();
  agentResult.textContent = "";
  form.reset();
  resetLocationSearch();
  status.textContent = "";
  void restoreSelection(null);
  projectStatus.textContent = "New project. Save it to keep the brief and selected shot.";
});

async function openSavedProject(id) {
  if (projectLocked || !id) return;
  projectLocked = true;
  openProject.disabled = true;
  try {
    const project = readProjects().find(item => item.id === id);
    if (!project) return false;
    const opened = await restoreSelection(project.selection);
    projectId = project.id;
    setProjectLink(projectId);
    projectForm.elements.title.value = project.title;
    setAgentSettings(project.settings);
    form.elements.q.value = project.query || "";
    form.elements.city.value = project.filters?.city || "";
    form.elements.category.value = project.filters?.category || "";
    form.elements.linked.checked = project.filters?.linked === true;
    form.elements.imported.checked = project.filters?.imported === true;
    resetLocationSearch();
    status.textContent = "";
    if (project.query?.trim() || project.filters?.city || project.filters?.category || project.filters?.linked || project.filters?.imported) form.requestSubmit();
    agentEvidence.replaceChildren();
    agentActivity.replaceChildren();
    agentResult.textContent = "";
    revisionHistory = project.revisions || [];
    shortlist = project.shortlist || [];
    renderShortlist();
    previousRoom = undefined;
    undoAgent.hidden = true;
    projectList.value = projectId;
    updateDeleteAction();
    projectStatus.textContent = opened ? "Opened " + project.title + "."
      : "Opened " + project.title + ". The saved room could not be loaded.";
    return true;
  } catch {
    projectStatus.textContent = "Could not open the project.";
  } finally {
    projectLocked = false;
    openProject.disabled = false;
    renderHistory();
  }
}
openProject.addEventListener("click", () => openSavedProject(projectList.value));

document.querySelector("#export-project").addEventListener("click", () => {
  if (projectLocked) return;
  try {
    const project = readProjects().find(item => item.id === projectList.value);
    if (!project) {
      projectStatus.textContent = "Save or select a project to export.";
      return;
    }
    const blob = new Blob([JSON.stringify({version: 1, project}, null, 2)], {type: "application/json"});
    if (blob.size > projectArchiveMaxBytes) {
      projectStatus.textContent = "This saved project exceeds the 1 MB transfer limit.";
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "scouting-project.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    projectStatus.textContent = "Exported the saved project. Room scans must be available on the receiving machine.";
  } catch {
    projectStatus.textContent = "Could not export the selected project.";
  }
});

document.querySelector("#import-project").addEventListener("change", async event => {
  const input = event.currentTarget;
  const file = input.files[0];
  input.value = "";
  if (!file || projectLocked) return;
  input.disabled = true;
  try {
    if (file.size > projectArchiveMaxBytes) throw Error("Project files must be 1 MB or smaller.");
    let project;
    try {
      project = parseProjectArchive(await file.text());
    } catch {
      throw Error("Could not read this scouting project file.");
    }
    if (projectLocked) return;
    const imported = writeProject({...project, id: crypto.randomUUID()});
    refreshProjects();
    await openSavedProject(imported.id);
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    input.disabled = false;
  }
});

try { refreshProjects(); } catch { projectStatus.textContent = "Saved projects could not be read."; }

document.querySelector("#import-shot").addEventListener("change", async event => {
  const input = event.currentTarget;
  const file = input.files[0];
  input.value = "";
  if (!file || projectLocked) return;
  input.disabled = true;
  const initialRequest = roomRequest;
  try {
    if (file.size > projectArchiveMaxBytes) throw Error("Shot files must be 1 MB or smaller.");
    const {modelId, roomId, setup} = readShotExport(await file.text());
    if (projectLocked || initialRequest !== roomRequest) return;
    const opening = inspectRoom({name: modelId}, modelId, roomId, setup);
    const request = roomRequest;
    const opened = await opening;
    if (request !== roomRequest || request.signal.aborted) return;
    projectStatus.textContent = opened ? "Opened the shot export and rechecked it against local room evidence."
      : "The exported shot needs its referenced room to be available locally.";
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    input.disabled = false;
  }
});

const undoAgent = document.querySelector("#undo-agent");
let previousRoom;
undoAgent.addEventListener("click", async () => {
  if (!previousRoom) return;
  const room = previousRoom;
  previousRoom = undefined;
  undoAgent.hidden = true;
  await inspectRoom({name: room.label || room.modelId}, room.modelId, room.roomId, room.proposedShot);
});
const briefReview = document.querySelector("#brief-review");
const investigate = document.querySelector("#investigate-shot");
let reviewedBrief;

function scoutingConstraints() {
  const inputs = new FormData(agentForm);
  const shortlisted = inputs.has("shortlist-only");
  const lockRoom = inputs.has("lock-room");
  return {
    brief: inputs.get("brief").trim(),
    lockedMove: inputs.get("locked-move") || null,
    lockedLens: inputs.get("lens") ? Number(inputs.get("lens")) : null,
    targetTravel: inputs.get("target-travel") === "" ? null : Number(inputs.get("target-travel")),
    minimumTravel: Number(inputs.get("minimum-travel")),
    allowApply: inputs.has("apply"),
    allowImport: inputs.has("import-outlines"),
    requireSightlines: inputs.has("require-sightlines"),
    shortlist: shortlisted ? shortlist.slice() : null,
    lockedRoom: lockRoom,
    currentModel: lockRoom ? selectedRoom?.modelId ?? null : null,
    currentRoomId: lockRoom ? selectedRoom?.roomId ?? null : null,
    catalogFilters: shortlisted ? {} : {
      city: form.elements.city.value,
      category: form.elements.category.value,
    },
  };
}

function clearBriefReview() {
  reviewedBrief = undefined;
  briefReview.hidden = true;
  investigate.disabled = true;
}

agentForm.addEventListener("input", clearBriefReview);
form.addEventListener("change", clearBriefReview);
document.querySelector("#suggest-constraints").addEventListener("click", () => {
  if (projectLocked) return;
  const {lens, minimumTravel} = briefSuggestions(agentForm.elements.brief.value);
  const filled = [];
  for (const [name, value, label] of [
    ["lens", lens, "lens"],
    ["minimum-travel", minimumTravel, "minimum travel"],
  ]) {
    const field = agentForm.elements[name];
    if (value !== null && field.value === "") {
      field.value = String(value);
      filled.push(label);
    }
  }
  if (filled.length) clearBriefReview();
  agentResult.textContent = filled.length
    ? "Filled " + filled.join(" and ") + ". Edit the values or review constraints."
    : "No empty fields matched. Use “35 mm lens” or “at least 0.7 m of travel” in the brief.";
});

document.querySelector("#review-brief").addEventListener("click", () => {
  if (projectLocked || !agentForm.reportValidity()) return;
  clearBriefReview();
  const constraints = scoutingConstraints();
  if (!constraints.brief || (constraints.shortlist && !constraints.shortlist.length) ||
      (constraints.lockedRoom && (!constraints.currentModel || !currentShot()))) {
    agentResult.textContent = !constraints.brief ? "Enter a shot brief."
      : constraints.lockedRoom && !currentShot() ? "Open a shot before locking the current room."
      : "Shortlist a scan before using shortlist-only scouting.";
    return;
  }
  if (constraints.lockedMove === "static" && (constraints.minimumTravel > 0 || constraints.targetTravel > 0)) {
    agentResult.textContent = "Use zero travel for a static shot.";
    return;
  }
  if (constraints.targetTravel !== null && constraints.targetTravel < constraints.minimumTravel) {
    agentResult.textContent = "Preferred travel must be at least the minimum.";
    return;
  }
  const {city, category} = constraints.catalogFilters;
  const lines = [
    constraints.shortlist ? "Scope: " + constraints.shortlist.length + " shortlisted scans."
      : "Catalog filters: " + [city, category].filter(Boolean).join(" · "),
    constraints.lockedRoom ? "Room locked: " + (selectedRoom.label || constraints.currentModel) : "",
    constraints.lockedLens === null ? "Lens: use brief as guidance or lock a lens above."
      : "Locked lens: " + constraints.lockedLens + " mm.",
    constraints.lockedMove ? "Locked camera move: " + agentForm.elements["locked-move"].selectedOptions[0].textContent : "",
    constraints.targetTravel === null ? "" : "Preferred travel: " + constraints.targetTravel + " m.",
    "Minimum travel: " + constraints.minimumTravel + " m.",
    constraints.requireSightlines ? "Captured sightlines required." : "Captured sightlines optional.",
    constraints.allowImport ? "Matterport room and MatterPak imports allowed for this run." : "",
    constraints.allowApply ? "Open a qualifying proposal automatically." : "Report proposals only.",
  ];
  if (!constraints.shortlist && !city && !category) lines[0] = "Catalog city and property type are flexible.";
  briefReview.querySelector("ul").replaceChildren(...lines.filter(Boolean).map(line => element("li", line)));
  briefReview.hidden = false;
  reviewedBrief = JSON.stringify(constraints);
  investigate.disabled = false;
  agentResult.textContent = "Review the constraints, then investigate.";
});

agentForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (projectLocked) return;
  const constraints = scoutingConstraints();
  if (reviewedBrief !== JSON.stringify(constraints)) {
    clearBriefReview();
    agentResult.textContent = "Review the current constraints before investigating.";
    return;
  }
  projectLocked = true;
  openProject.disabled = true;
  renderHistory();
  let applied = false;
  const inputs = new FormData(agentForm);
  const button = investigate;
  const initialRoom = selectedRoom;
  const previousShot = currentShot();
  const initialShot = JSON.stringify(previousShot);
  let expectedRoom = initialRoom;
  let expectedShot = initialShot;
  button.disabled = true;
  agentEvidence.replaceChildren();
  agentActivity.replaceChildren();
  agentResult.textContent = "Investigating the shot…";
  try {
    const prior = initialRoom
      ? " Current editor: " + roomName(initialRoom.label, initialRoom.roomId) +
        ". Lens: " + document.querySelector("#lens").value + " mm."
      : "";
    agentResult.textContent = await runAgent(constraints.brief + prior, {
      ...constraints,
      currentModel: initialRoom?.modelId,
      current: previousShot && {roomId: initialRoom?.roomId, lens: previousShot.lens, travel: previousShot.travel,
        sensorWidthMm: previousShot.sensorWidthMm, cameraHeight: previousShot.cameraHeight, rigRadius: previousShot.rigRadius,
        durationSeconds: previousShot.durationSeconds,
        moveKind: previousShot.moveKind, keepMark: previousShot.keepMark, requireSightlines: previousShot.requireSightlines},
      revise: request => {
        if (initialRoom !== selectedRoom || initialShot !== JSON.stringify(currentShot()))
          throw Error("The open setup changed during scouting.");
        return planCurrentShot(request);
      },
      onEvidence: ({coverage, candidates, unverifiedLeads, recommended, queued}) => {
        agentEvidence.replaceChildren();
        if (coverage.shortlistedScans || coverage.propertiesFound || candidates.length) {
          const scope = coverage.shortlistedScans === null
            ? coverage.propertiesFound + " distinct CoStar properties surfaced"
            : coverage.shortlistedScans + " shortlisted scans in scope";
          agentEvidence.append(element("p", scope + " · " + coverage.roomsEvaluated +
            " distinct rooms evaluated · " + candidates.length + " setups tested"));
        }
        if (candidates.length) {
          const list = element("ol", "");
          for (const candidate of candidates) {
            const {id, label, room, status, outcome, unmet, travel, requested,
              clearanceMargin, framingMargin, sightlinesSampled, missingEvidence} = candidate;
            const entry = element("li", "");
            entry.dataset.candidate = id;
            entry.append(element("strong", [roomName(label, room),
              id === recommended ? "Top technical match" : status.replace("missing-evidence", "Missing evidence"),
              id === queued ? "Selected proposal" : ""].filter(Boolean).join(" · ")));
            entry.append(element("p", outcome));
            const measurements = [
              Number.isFinite(travel) ? travel.toFixed(2) + " m of " + requested.toFixed(2) + " m requested" : "",
              Number.isFinite(clearanceMargin) ? Math.floor(clearanceMargin * 100) + " cm beyond rig radius" : "",
              Number.isFinite(framingMargin) ? Math.floor(framingMargin * 100) + "% frame margin" : "",
              Number.isFinite(travel) ? (sightlinesSampled ? "Sampled sightlines clear" : "Sightlines unverified") : "",
            ].filter(Boolean);
            if (measurements.length) entry.append(element("p", measurements.join(" · ")));
            if (missingEvidence?.length) entry.append(element("p", "Still needed · " + missingEvidence.join(", ")));
            if (unmet.length) entry.append(element("p", "Unmet requirements · " + unmet.join(", ")));
            list.append(entry);
          }
          agentEvidence.append(element("h3", "Tested setups"), list);
        }
        if (unverifiedLeads.length) {
          const list = element("ul", "");
          for (const lead of unverifiedLeads) {
            const entry = element("li", [lead.name, lead.city,
              lead.models.length ? "Room outline not confirmed" : "No linked scan"].filter(Boolean).join(" · "));
            if (lead.evidence) entry.append(element("p", lead.evidence));
            for (const [index, scan] of lead.scans.entries()) {
              const open = element("button", "Inspect " + (spaceLabel(scan.caption) || `space ${index + 1}`));
              open.type = "button";
              open.addEventListener("click", () => inspectRoom({name: lead.name || scan.model}, scan.model));
              entry.append(open);
              if (scan.importError) entry.append(element("p", scan.importError));
            }
            list.append(entry);
          }
          agentEvidence.append(element("h3", "Leads needing room evidence"), list);
        }
      },
      onAlternatives: alternatives => {
        for (const {id, room, setup} of alternatives) {
          const entry = agentEvidence.querySelector('[data-candidate="' + id + '"]');
          if (!entry) continue;
          const open = element("button", "Open checked setup");
          open.type = "button";
          open.addEventListener("click", async () => {
            if (projectLocked) return;
            open.disabled = true;
            try {
              await openCheckedProposal(room, setup);
              agentResult.textContent = "Opened " + id + " for review.";
            } catch (error) {
              agentResult.textContent = error.message;
            } finally {
              open.disabled = false;
            }
          });
          entry.append(open);
        }
      },
      activity: text => agentActivity.append(element("li", text)),
      apply: async (room, setup, requireCapture) => {
        if (expectedRoom !== selectedRoom || expectedShot !== JSON.stringify(currentShot()))
          throw Error("The open setup changed during scouting. Your changes were kept.");
        if (!room) {
          applyCurrentShot(setup);
          applied = true;
          previousRoom = {...initialRoom, proposedShot: previousShot};
          undoAgent.hidden = false;
          return;
        }
        try {
          await openCheckedProposal(room, setup, requireCapture);
        } catch (error) {
          if (error.code === "capture-unavailable") {
            expectedRoom = selectedRoom;
            expectedShot = JSON.stringify(currentShot());
          }
          throw error;
        }
        applied = true;
        previousRoom = initialRoom && {...initialRoom, proposedShot: previousShot || initialRoom.proposedShot};
        undoAgent.hidden = !previousRoom;
      },
    });
    if (applied) {
      revisionHistory.push({brief: inputs.get("brief"), selection: selectionSnapshot(),
        activity: [...agentActivity.children].map(item => item.textContent)});
      revisionHistory = revisionHistory.slice(-20);
    }
  } catch (error) {
    agentResult.textContent = error.message;
  } finally {
    button.disabled = reviewedBrief !== JSON.stringify(scoutingConstraints());
    projectLocked = false;
    openProject.disabled = false;
    renderHistory();
  }
});
fetch("/api/agent-status").then(response => response.json()).then(({configured}) => {
  if (!configured && !agentResult.textContent) agentResult.textContent =
    "Connect a model provider to enable scouting by brief. Search and manual shot tools are available.";
}).catch(() => {});

async function restoreWorkspace() {
  const savedProject = restore.get("project");
  if (savedProject && await openSavedProject(savedProject)) return;
  if (savedProject) setProjectLink(null);
  if (requestedModel) await inspectRoom({name: restore.get("name") || "Room plan"},
    requestedModel, restore.get("room"));
}
void restoreWorkspace();
