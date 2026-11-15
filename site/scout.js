import {maxCurvePoints, readShotExport, roundStroke} from "./path.js?v=5";
import {deleteProject, parseProjectArchive, projectArchiveMaxBytes, readProjects, writeProject} from "./projects.js?v=11";
import {loadObstacles, outlineMeasurements, roomKey} from "./room-state.js";
import {briefSuggestions, reviewShotBrief, runAgent} from "./agent.js?v=brief-review";
import {compareCapturedRooms} from "./compare.js";
import {openMesh, closeMesh, currentShot, planCurrentShot, applyCurrentShot} from "./mesh.js?v=brief-review";
import {addMapLocations, resetLocationMap} from "./location-map.js?v=9";

const form = document.querySelector("#scout-search");
const results = document.querySelector("#results");
const workspace = document.querySelector("#workspace");
const roomTitle = document.querySelector("#room-title");
const roomLocation = document.querySelector("#room-location");
const roomGeometry = document.querySelector("#room-geometry");
const projectLocation = document.querySelector("#project-location");
const roomPanel = roomTitle.closest("aside");
const backToResults = document.querySelector("#back-to-results");
const toggleScouting = document.querySelector("#toggle-scouting");
const scouting = document.querySelector("#scouting");
function setSidebarVisible(visible) {
  scouting.hidden = !visible;
  toggleScouting.setAttribute("aria-expanded", String(visible));
  toggleScouting.textContent = visible ? "Hide sidebar" : "Show sidebar";
}
toggleScouting.addEventListener("click", () => setSidebarVisible(scouting.hidden));
backToResults.addEventListener("click", () => {
  setSidebarVisible(true);
  workspace.dataset.browse = "";
  form.querySelector("input[name=q]").focus();
});
document.querySelector('a[href="#scouting"]').addEventListener("click", () => setSidebarVisible(true));
document.querySelector('a[href="#room-title"]').addEventListener("click", () => {
  delete workspace.dataset.browse;
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

function roomName(label, id) {
  const name = label?.trim();
  return !name || name === id || name === `Room ${id}` ? "Room" : name;
}

function roomNames(choices) {
  const names = choices.map(({label, id}) => roomName(label, id));
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
let pose;
let draft;
let drawing = false;
let stroke;
let strokePointer;
let actorDrag;
let planDrag;
let planOffset = [0, 0];
let planZoom = 1;
let panning = false;
let obstacles = [];
let obstacleKey;
let marking = false;
const placeMark = document.querySelector("#place-mark");
const markButton = document.querySelector("#mark-obstacle");
const undoButton = document.querySelector("#undo-obstacle");
const instructions = document.querySelector("#plan-instructions");
const tools = document.querySelector("#plan-tools");
const drawCurve = document.querySelector("#draw-curve");
const panPlan = document.querySelector("#pan-plan");
const planViewTools = panPlan.parentElement;

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
  drawPlan?.(pose);
}

function zoomPlan(factor) {
  const zoom = Math.max(.35, Math.min(3, planZoom * factor));
  planOffset = planOffset.map(value => value * zoom / planZoom);
  planZoom = zoom;
  drawPlan?.(pose);
}

panPlan.addEventListener("click", () => {
  const enabled = !panning;
  setDrawing(false);
  setPanning(enabled);
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
  markButton.setAttribute("aria-pressed", String(enabled));
  instructions.textContent = enabled ? "Drag around the furniture footprint."
    : "Drag A1 or A2 to move an actor. Click empty space to place the selected mark.";
  drawPlan?.(pose);
}

function setDrawing(enabled) {
  setPanning(false);
  setMarking(false);
  drawing = enabled;
  stroke = undefined;
  strokePointer = undefined;
  drawCurve.setAttribute("aria-pressed", String(enabled));
  if (enabled) instructions.textContent = "Drag from the start to the end of the camera move. Release to play.";
  drawPlan?.(pose);
}

function publishObstacles() {
  undoButton.disabled = obstacles.length === 0;
  if (obstacleKey) {
    try { localStorage.setItem(obstacleKey, JSON.stringify(obstacles)); } catch {}
  }
  canvas.dispatchEvent(new CustomEvent("obstacleschange", {detail: obstacles.slice()}));
  drawPlan?.(pose);
}

drawCurve.addEventListener("click", () => setDrawing(!drawing));
markButton.addEventListener("click", () => {
  const enabled = !marking;
  setDrawing(false);
  setMarking(enabled);
});
placeMark.addEventListener("change", () => setDrawing(false));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && (drawing || panning)) setDrawing(false);
});
undoButton.addEventListener("click", () => {
  obstacles.pop();
  publishObstacles();
});
canvas.addEventListener("shotmounted", () => {
  tools.hidden = false;
  publishObstacles();
});
canvas.addEventListener("pointerdown", event => {
  if (!toWorld || event.button !== 0) return;
  if (panning || event.shiftKey) {
    if (planDrag || stroke || actorDrag || draft) return;
    canvas.setPointerCapture(event.pointerId);
    planDrag = {pointer: event.pointerId, x: event.clientX, y: event.clientY, offset: planOffset};
    return;
  }
  if (document.querySelector("#viewport").hidden) return;
  const point = toWorld(event);
  if (drawing) {
    if (stroke) return;
    canvas.setPointerCapture(event.pointerId);
    strokePointer = event.pointerId;
    stroke = [point];
    return;
  }
  if (!marking) {
    if (actorDrag) return;
    const [x, z] = toWorld({clientX: event.clientX + 14, clientY: event.clientY + 14});
    const hit = pose?.actors.findIndex(mark => mark &&
      Math.hypot((mark[0] - point[0]) / (x - point[0]), (mark[1] - point[1]) / (z - point[1])) <= 1);
    if (hit >= 0) {
      canvas.setPointerCapture(event.pointerId);
      actorDrag = {pointer: event.pointerId, index: hit, origin: point, point, map: toWorld};
      return;
    }
    if (placeMark.value === "camera") {
      canvas.dispatchEvent(new CustomEvent("choosecamera", {detail: point}));
    } else if (placeMark.value === "aim") {
      canvas.dispatchEvent(new CustomEvent("chooseaim", {detail: point}));
    } else if (placeMark.value === "start" || placeMark.value === "end") {
      canvas.dispatchEvent(new CustomEvent("chooseendpoint", {detail: {which: placeMark.value, point}}));
    } else {
      canvas.dispatchEvent(new CustomEvent("chooseactor", {detail: {index: Number(placeMark.value), point}}));
    }
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  draft = [point, point];
});
canvas.addEventListener("pointermove", event => {
  if (planDrag?.pointer === event.pointerId) {
    const box = canvas.getBoundingClientRect();
    planOffset = [planDrag.offset[0] + (event.clientX - planDrag.x) * canvas.width / box.width,
      planDrag.offset[1] + (event.clientY - planDrag.y) * canvas.height / box.height];
    drawPlan?.(pose);
    return;
  }
  if (stroke && event.pointerId === strokePointer) {
    const point = toWorld(event);
    const previous = stroke.at(-1);
    if (stroke.length < maxCurvePoints / 2 - 1 &&
        Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= .015) stroke.push(point);
    drawPlan?.(pose);
    return;
  }
  if (actorDrag?.pointer === event.pointerId && actorDrag.map === toWorld) {
    actorDrag.point = toWorld(event);
    drawPlan?.(pose);
    return;
  }
  if (!draft || !toWorld) return;
  draft[1] = toWorld(event);
  drawPlan?.(pose);
});
canvas.addEventListener("pointerup", event => {
  if (planDrag?.pointer === event.pointerId) {
    planDrag = undefined;
    return;
  }
  if (stroke && event.pointerId === strokePointer) {
    const path = roundStroke([...stroke, toWorld(event)]);
    setDrawing(false);
    canvas.dispatchEvent(new CustomEvent("drawcamera", {detail: path}));
    return;
  }
  if (actorDrag?.pointer === event.pointerId) {
    const {index, origin, map} = actorDrag;
    actorDrag = undefined;
    if (map === toWorld) {
      const point = map(event);
      if (Math.hypot(point[0]-origin[0], point[1]-origin[1]) > .005)
        canvas.dispatchEvent(new CustomEvent("chooseactor", {detail: {index, point}}));
      drawPlan?.(pose);
    }
    return;
  }
  if (!draft || !toWorld) return;
  const [a, b] = draft;
  const min = a.map((value, i) => Math.min(value, b[i]));
  const max = a.map((value, i) => Math.max(value, b[i]));
  if (max.every((value, i) => value - min[i] >= .08)) {
    obstacles.push({min, max, name: "marked furniture " + (obstacles.length + 1)});
  }
  setMarking(false);
  publishObstacles();
});
canvas.addEventListener("pointercancel", event => {
  if (planDrag?.pointer === event.pointerId) planDrag = undefined;
  if (actorDrag?.pointer === event.pointerId) {
    actorDrag = undefined;
    drawPlan?.(pose);
  } else if (event.pointerId === strokePointer || draft) setDrawing(false);
});
document.querySelector("#viewport").addEventListener("shotpose", event => {
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
    const entry = element("li", item.label + " · " + item.caption + " ");
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
  if (row.evidence) article.append(element("p", row.evidence));
  const models = Object.entries(row.models);
  if (!models.length) {
    article.append(element("p", "No linked Matterport scan."));
    return article;
  }
  const scans = element("select", "");
  scans.setAttribute("aria-label", "Scan for " + (row.name || row.street));
  for (const [index, [id, caption]] of models.entries()) {
    scans.add(new Option(caption?.trim() || `Scan ${index + 1}`, id));
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
        : scan.remoteRoomCount ? `${scan.remoteRoomCount} confirmed outlines · import on open`
        : scan.remoteOutlineStatus === "no-floor-edges" ? "Matterport returned no floor edges"
        : ["no-room-edges", "no-room-records", "boundary-rejected"].includes(scan.remoteOutlineStatus)
          ? "No usable room outline"
        : ["unavailable", "request-failed"].includes(scan.remoteOutlineStatus)
          ? "Matterport outline check unavailable"
        : "Room outline unverified";
    }
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
      shortlist.push({modelId, label: row.name || row.street, caption: row.models[modelId]?.trim() || `Scan ${scans.selectedIndex + 1}`});
      renderShortlist();
    }
    shortlistPanel.open = true;
    void inspectRoom(row, modelId);
    roomTitle.focus();
  });
  const actions = element("div", "");
  actions.className = "location-actions";
  actions.append(inspect, pin);
  article.append(scans, scanStatus, actions);
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
  canvas.hidden = capture.hidden = rigWidth.hidden = planViewTools.hidden = true;
  resetPlanView();
  drawPlan = toWorld = pose = undefined;
  tools.hidden = true;
  placeMark.value = "camera";
  obstacles = [];
  obstacleKey = undefined;
  setDrawing(false);
  roomStatus.textContent = "Looking for imported rooms…";
  try {
    const params = new URLSearchParams({model});
    const choices = await fetch("/api/rooms?" + params, {signal: request.signal}).then(response =>
      response.ok ? response.json() : []);
    if (request.signal.aborted) return;
    enableMeasuredImport(row, model, request.signal);
    const names = roomNames(choices);
    if (choices.length > 1) {
      const selected = choices.findIndex(choice => choice.id === (roomId ?? choices[0].id));
      roomOptions.replaceChildren(...names.map((name, index) => new Option(name, String(index))));
      roomOptions.selectedIndex = Math.max(selected, 0);
      roomOptions.onchange = () => inspectRoom(row, model, choices[roomOptions.selectedIndex].id);
      roomPicker.hidden = false;
    }
    if (roomId) params.set("room", roomId);
    const response = await fetch("/api/room?" + params, {signal: request.signal});
    const data = await response.json();
    if (request.signal.aborted) return;
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
    document.querySelector("#room-title").textContent = names[roomIndex] || roomName(data.label, data.roomId);
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
  actorDrag = undefined;
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
  const context = canvas.getContext("2d");
  canvas.hidden = planViewTools.hidden = false;
  toWorld = event => {
    const scale = fitScale * planZoom;
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width * canvas.width;
    const z = (event.clientY - box.top) / box.height * canvas.height;
    return [left + (x - planOffset[0] - (canvas.width - width * scale) / 2) / scale,
      top + (z - planOffset[1] - (canvas.height - depth * scale) / 2) / scale];
  };
  drawPlan = pose => {
    const scale = fitScale * planZoom;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate((canvas.width - width * scale) / 2 + planOffset[0],
      (canvas.height - depth * scale) / 2 + planOffset[1]);
    const coords = ([x, z]) => [(x - left) * scale, (z - top) * scale];
    context.beginPath();
    points.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
    context.closePath();
    context.fillStyle = "#354844";
    context.fill();
    context.strokeStyle = "#83b3a4";
    context.lineWidth = 3;
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
      context.fillRect(x, z, endX - x, endZ - z);
      context.strokeRect(x, z, endX - x, endZ - z);
    }
    if (pose) {
      const footprint = pose.pathPoints || [pose.from, pose.to];
      const diameter = 2 * pose.rigRadius * scale;
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
    if (stroke || pose) {
      const path = stroke || pose.pathPoints || [pose.from, pose.to];
      context.beginPath();
      path.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
      context.strokeStyle = !stroke && document.querySelector("#clearance").dataset.result === "fail"
        ? "#ff8b82" : "#f1b87b";
      context.lineWidth = stroke ? 4 : Math.min(3, pose.rigRadius * scale);
      context.lineJoin = context.lineCap = "round";
      context.stroke();
    }
    if (pose) {
      context.beginPath();
      context.moveTo(...coords([pose.x, pose.z]));
      context.lineTo(...coords([pose.tx, pose.tz]));
      context.setLineDash([6, 6]);
      context.lineWidth = 2;
      context.stroke();
      context.setLineDash([]);
      const [aimX, aimZ] = coords([pose.tx, pose.tz]);
      context.strokeRect(aimX - 6, aimZ - 6, 12, 12);
      if (pose.pathPoints || Math.hypot(pose.to[0] - pose.from[0], pose.to[1] - pose.from[1]) > .01) {
        context.fillStyle = "#f4d9b8";
        context.font = "bold 15px system-ui";
        for (const [label, point] of [["START", pose.from], ["END", pose.to]]) {
          const [x, y] = coords(point);
          context.fillRect(x - 3, y - 3, 6, 6);
          context.fillText(label, x + 8, y - 9);
        }
      }
      if (actorDrag?.map === toWorld) {
        const [x, z] = coords(actorDrag.point);
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(x, z, 10, 0, 2 * Math.PI);
        context.stroke();
      }
      for (const [index, point] of pose.actors.entries()) {
        if (!point) continue;
        const [x, y] = coords(point);
        context.fillStyle = index ? "#a1d1e3" : "#f1b87b";
        context.font = "bold 16px system-ui";
        context.fillText("A" + (index + 1), x + 9, y - 7);
        context.beginPath();
        context.arc(x, y, 6, 0, 2 * Math.PI);
        context.fill();
      }
      for (const [point, radius] of [[[pose.x, pose.z], 8], [[pose.tx, pose.tz], 4]]) {
        context.beginPath();
        context.arc(...coords(point), radius, 0, 2 * Math.PI);
        context.fillStyle = context.strokeStyle;
        context.fill();
      }
    }
    context.restore();
  };
  drawPlan();
  const source = room.geometrySource || "Imported outline";
  roomGeometry.textContent = source + " · " + width.toFixed(2) + " m × " +
    depth.toFixed(2) + " m bounds · " + outlineMeasurements(points).area.toFixed(1) +
    " m² outline area";
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
    const noMatches = filters.get("confirmed") === "1"
      ? "No matches with a confirmed room outline. Clear the outline filter to include unverified scans."
      : "No matching properties.";
    status.textContent = (count ? count + " property matches shown" : noMatches) + coverage;
  } catch (error) {
    if (!request.signal.aborted) status.textContent = error.message;
  } finally {
    if (searchRequest === request) button.disabled = moreLocations.disabled = false;
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const filters = new URLSearchParams(new FormData(form));
  if (filters.has("imported")) {
    filters.delete("imported");
    filters.set("confirmed", "1");
  }
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
      card.append(element("h3", entry.label + " · " + entry.caption),
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
const agentOptions = document.querySelector("#agent-options");
const agentTests = document.querySelector("#agent-tests");
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
  roomPicker.hidden = canvas.hidden = capture.hidden = tools.hidden = rigWidth.hidden = planViewTools.hidden = true;
  setSidebarVisible(true);
  drawPlan = toWorld = pose = undefined;
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
  const missingSightlines = opened && setup.requireSightlines && document.querySelector("#check-scan").disabled;
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
  interpretedBrief = undefined;
  inferredFields.clear();
  manuallyEdited.clear();
  shotPlan.open = false;
  agentForm.elements["import-outlines"].checked = false;
  agentForm.elements.brief.value = settings.brief ?? "";
  agentForm.elements.lens.value = settings.lens ?? "";
  agentForm.elements["locked-move"].value = settings.lockedMove ?? "";
  agentForm.elements["target-travel"].value = settings.targetTravel ?? "";
  agentForm.elements["minimum-travel"].value = settings.minimumTravel ?? "";
  agentForm.elements["shortlist-only"].checked = settings.shortlistOnly === true;
  agentForm.elements["lock-room"].checked = settings.lockRoom === true;
  agentForm.elements["require-sightlines"].checked = settings.requireSightlines === true;
  agentForm.elements.apply.checked = settings.apply === true;
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
  clearAgentResults();
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
    clearAgentResults();
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
const reviewButton = document.querySelector("#review-brief");
const shotPlan = document.querySelector("#shot-plan");
let reviewedBrief, interpretedBrief, reviewRequest;
const inferredFields = new Map();
const manuallyEdited = new Set();

function clearAgentResults() {
  agentOptions.replaceChildren();
  agentEvidence.replaceChildren();
  agentActivity.replaceChildren();
  agentTests.hidden = true;
  agentTests.open = false;
}

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
      confirmedOnly: form.elements.imported.checked,
      city: form.elements.city.value,
      category: form.elements.category.value,
    },
  };
}

function clearBriefReview() {
  reviewRequest?.abort();
  reviewRequest = undefined;
  reviewButton.disabled = false;
  reviewedBrief = undefined;
  briefReview.hidden = true;
  investigate.disabled = true;
}

agentForm.addEventListener("input", event => {
  clearBriefReview();
  const name = event.target.name;
  if (name === "brief") {
    for (const [field, previous] of inferredFields) {
      const input = agentForm.elements[field];
      if (input.type === "checkbox") {
        if (input.checked === previous) input.checked = false;
      } else if (input.value === previous) input.value = "";
    }
    inferredFields.clear();
    interpretedBrief = undefined;
  } else {
    inferredFields.delete(name);
    manuallyEdited.add(name);
  }
});
form.addEventListener("change", clearBriefReview);

function fillReviewSuggestions(draft) {
  for (const [name, value] of [["lens", draft.lens], ["locked-move", draft.move],
      ["target-travel", draft.targetTravel], ["minimum-travel", draft.minimumTravel]]) {
    const field = agentForm.elements[name];
    if (value !== null && !field.value && !manuallyEdited.has(name)) {
      field.value = String(value);
      inferredFields.set(name, field.value);
    }
  }
  const shortlistOnly = agentForm.elements["shortlist-only"];
  const lockRoom = agentForm.elements["lock-room"];
  if (!shortlistOnly.checked && !lockRoom.checked &&
      !manuallyEdited.has("shortlist-only") && !manuallyEdited.has("lock-room")) {
    const field = draft.scope === "shortlist" ? shortlistOnly : draft.scope === "current_room" ? lockRoom : null;
    if (field) {
      field.checked = true;
      inferredFields.set(field.name, true);
    }
  }
}

reviewButton.addEventListener("click", async () => {
  if (projectLocked || !agentForm.reportValidity()) return;
  clearBriefReview();
  shotPlan.open = true;
  const brief = agentForm.elements.brief.value.trim();
  if (!brief) {
    agentResult.textContent = "Enter a shot brief.";
    return;
  }
  let reviewMessage = interpretedBrief?.message ?? "";
  if (interpretedBrief?.brief !== brief) {
    const request = new AbortController();
    reviewRequest = request;
    reviewButton.disabled = true;
    agentResult.textContent = "Reading the shot brief…";
    try {
      const draft = await reviewShotBrief(brief, {signal: request.signal});
      if (request.signal.aborted) return;
      fillReviewSuggestions(draft);
      reviewMessage = "Check the suggested shot plan, then investigate.";
    } catch {
      if (request.signal.aborted) return;
      fillReviewSuggestions({move: null, scope: null, targetTravel: null, ...briefSuggestions(brief)});
      reviewMessage = "Model review unavailable. Check the shot plan manually. Investigation needs a connected model provider.";
    } finally {
      if (reviewRequest === request) {
        reviewRequest = undefined;
        reviewButton.disabled = false;
      }
    }
    interpretedBrief = {brief, message: reviewMessage};
  }
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
    constraints.catalogFilters.confirmedOnly ? "Search scans with confirmed room outlines." : "",
    constraints.allowImport ? "Matterport room and MatterPak imports allowed for this run." : "",
    constraints.allowApply ? "Open a qualifying proposal automatically." : "Report proposals only.",
  ];
  if (!constraints.shortlist && !city && !category) lines[0] = "Catalog city and property type are flexible.";
  briefReview.querySelector("ul").replaceChildren(...lines.filter(Boolean).map(line => element("li", line)));
  briefReview.hidden = false;
  reviewedBrief = JSON.stringify(constraints);
  investigate.disabled = false;
  agentResult.textContent = reviewMessage;
});

function renderAgentOptions(options, tradeoff, {initialRoom, initialShot}) {
  agentOptions.replaceChildren();
  if (!options.length) {
    if (tradeoff) {
      const card = element("article", "");
      card.append(element("h3", "Closest measured tradeoff"),
        element("p", roomName(tradeoff.label, tradeoff.room) + " · " + tradeoff.travel.toFixed(2) + " m of travel"),
        element("p", "Misses " + tradeoff.unmet.join(", ") + "."),
        element("p", tradeoff.outcome));
      agentOptions.append(card);
    } else {
      agentOptions.append(element("p", "No tested setup is ready to open. Check the scouting evidence below."));
    }
    return;
  }

  for (const [index, option] of options.entries()) {
    const {room, setup, report, opened} = option;
    const card = element("article", "");
    const label = room ? roomName(room.label, room.roomId) : "Current room";
    card.append(element("h3", (index === 0 ? "Recommended" : "Alternative " + index) + " · " + label));
    const measurements = [
      report.travel.toFixed(2) + " m of travel",
      Number.isFinite(report.framingMargin) ? Math.floor(report.framingMargin * 100) + "% tightest frame margin" : "Frame margin unavailable",
      report.sightlinesSampled ? "Captured sightlines checked" : "Captured sightlines unverified",
    ];
    card.append(element("p", measurements.join(" · ")));
    if (opened) card.append(element("p", "Opened in the shot editor."));
    const open = element("button", "Open shot");
    open.type = "button";
    open.addEventListener("click", async () => {
      if (projectLocked || agentOptions.querySelector("button[disabled]")) return;
      open.disabled = true;
      try {
        if (room) await openCheckedProposal(room, setup);
        else {
          if (selectedRoom !== initialRoom || JSON.stringify(currentShot()) !== initialShot)
            throw Error("The original shot changed. Investigate the current shot again before applying this revision.");
          applyCurrentShot(setup);
        }
        agentResult.textContent = "Opened the tested shot in " + label + ".";
      } catch (error) {
        agentResult.textContent = error.message;
      } finally {
        open.disabled = false;
      }
    });
    card.append(open);
    agentOptions.append(card);
  }
}

agentForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (projectLocked) return;
  const constraints = scoutingConstraints();
  const confirmation = JSON.stringify(constraints);
  if (reviewedBrief !== confirmation) {
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
  clearAgentResults();
  agentTests.hidden = false;
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
            if (candidate.parent) entry.append(element("p", "Retried " + candidate.parent + " · " + candidate.adjustment));
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
              const open = element("button", "Inspect " + (scan.caption?.trim() || `scan ${index + 1}`));
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
      onResults: ({options, tradeoff}) => {
        renderAgentOptions(options, tradeoff, {initialRoom, initialShot});
      },
      activity: text => {
        agentActivity.append(element("li", text));
        agentResult.textContent = text;
      },
      apply: async (room, setup, requireCapture) => {
        if (reviewedBrief !== confirmation || JSON.stringify(scoutingConstraints()) !== confirmation)
          throw Error("The shot plan changed during scouting. Review the updated plan to run again.");
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
