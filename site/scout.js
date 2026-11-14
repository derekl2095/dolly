import {readShotExport} from "./path.js";
import {parseProjectArchive, projectArchiveMaxBytes, readProjects, writeProject} from "./projects.js";
import {loadObstacles, outlineMeasurements, roomKey} from "./room-state.js";
import {runAgent} from "./agent.js";
import {compareCapturedRooms} from "./compare.js";
import {openMesh, closeMesh, currentShot, planCurrentShot, applyCurrentShot} from "./mesh.js";

const form = document.querySelector("#scout-search");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
const roomStatus = document.querySelector("#room-status");
const canvas = document.querySelector("#plan");
let roomRequest;
let selectedRoom;
const roomPicker = document.querySelector("#room-picker");
const roomOptions = roomPicker.querySelector("select");
document.querySelector("#retry-mesh").addEventListener("click", async () => {
  if (!selectedRoom || !roomRequest) return;
  closeMesh();
  await openMesh(selectedRoom, roomRequest.signal);
  if (retryMesh.hidden) importMesh.hidden = true;
});
const importMesh = document.querySelector("#import-mesh");
const retryMesh = document.querySelector("#retry-mesh");
const renderStatus = document.querySelector("#render-status");
importMesh.addEventListener("click", async () => {
  const room = selectedRoom;
  const request = roomRequest;
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
    const shot = currentShot();
    closeMesh();
    await openMesh(shot ? {...room, proposedShot: shot} : room, request.signal);
  } catch (error) {
    if (!request.signal.aborted) renderStatus.textContent = error.message;
  } finally {
    if (!request.signal.aborted) {
      importMesh.hidden = retryMesh.hidden;
      importMesh.disabled = retryMesh.disabled = false;
    }
  }
});
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
let toWorld;
let pose;
let draft;
let obstacles = [];
let obstacleKey;
let marking = false;
const placeMark = document.querySelector("#place-mark");
const markButton = document.querySelector("#mark-obstacle");
const undoButton = document.querySelector("#undo-obstacle");
const instructions = document.querySelector("#plan-instructions");
const tools = document.querySelector("#plan-tools");
function setMarking(enabled) {
  marking = enabled;
  draft = undefined;
  markButton.setAttribute("aria-pressed", String(enabled));
  instructions.textContent = enabled ? "Drag around the furniture footprint."
    : "Click the plan to place the selected mark.";
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

markButton.addEventListener("click", () => setMarking(!marking));
undoButton.addEventListener("click", () => {
  obstacles.pop();
  publishObstacles();
});
canvas.addEventListener("shotmounted", () => {
  tools.hidden = false;
  publishObstacles();
});
canvas.addEventListener("pointerdown", event => {
  if (document.querySelector("#viewport").hidden || !toWorld || event.button !== 0) return;
  const point = toWorld(event);
  if (!marking) {
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
  if (!draft || !toWorld) return;
  draft[1] = toWorld(event);
  drawPlan?.(pose);
});
canvas.addEventListener("pointerup", event => {
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
canvas.addEventListener("pointercancel", () => setMarking(false));
document.querySelector("#viewport").addEventListener("shotpose", event => {
  pose = event.detail;
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
  for (const [id, caption] of models) {
    const scan = readiness[id];
    let status = "Local status unknown";
    if (scan) {
      if (scan.alignedRoomCount) status = scan.alignedRoomCount + " aligned scan room(s)";
      else if (scan.meshAvailable) status = "Mesh needs alignment review";
      else if (scan.roomCount) status = "Room outline only";
      else status = "Room import needed";
    }
    scans.add(new Option((caption || id) + " · " + status, id));
  }
  const inspect = element("button", "Inspect room");
  inspect.addEventListener("click", () => inspectRoom(row, scans.value));
  const pin = element("button", "Shortlist scan");
  pin.addEventListener("click", () => {
    const modelId = scans.value;
    if (shortlist.some(item => item.modelId === modelId)) {
      status.textContent = "That scan is already shortlisted.";
      return;
    }
    if (shortlist.length >= 30) {
      status.textContent = "Remove a scan before adding another to the shortlist.";
      return;
    }
    shortlist.push({modelId, label: row.name || row.street, caption: row.models[modelId] || modelId});
    shortlistPanel.open = true;
    renderShortlist();
  });
  article.append(scans, document.createElement("br"), inspect, pin);
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

async function inspectRoom(row, model, roomId, proposedShot) {
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
  document.querySelector("#room-title").textContent = row.name || row.street;
  canvas.hidden = capture.hidden = true;
  drawPlan = toWorld = pose = undefined;
  tools.hidden = true;
  placeMark.value = "camera";
  obstacles = [];
  obstacleKey = undefined;
  setMarking(false);
  roomStatus.textContent = "Looking for imported room " + model + "…";
  try {
    const params = new URLSearchParams({model});
    const choices = await fetch("/api/rooms?" + params, {signal: request.signal}).then(response =>
      response.ok ? response.json() : []);
    if (request.signal.aborted) return;
    enableMeasuredImport(row, model, request.signal);
    if (choices.length > 1) {
      const selected = choices.findIndex(choice => choice.id === (roomId ?? choices[0].id));
      roomOptions.replaceChildren(...choices.map((choice, index) =>
        new Option(choice.label + (choice.floorId ? " · " + choice.floorId : ""), String(index))));
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
      if (response.status === 404) {
        const available = await fetch("/api/room-import-status", {signal: request.signal})
          .then(reply => reply.ok ? reply.json() : {}).catch(() => ({}));
        if (available.configured && !request.signal.aborted) {
          const importButton = element("button", "Import room geometry");
          importButton.type = "button";
          importButton.addEventListener("click", async () => {
            importButton.disabled = true;
            roomStatus.replaceChildren(document.createTextNode("Importing Matterport room geometry…"));
            try {
              const reply = await fetch("/api/import-room", {method: "POST",
                headers: {"Content-Type": "application/json"}, body: JSON.stringify({model}),
                signal: request.signal});
              const result = await reply.json();
              if (request.signal.aborted) return;
              if (!reply.ok) throw Error(result.error);
              await inspectRoom(row, model, roomId, proposedShot);
            } catch (error) {
              if (!request.signal.aborted) {
                importButton.disabled = false;
                roomStatus.replaceChildren(document.createTextNode(error.message + " "), scan, " ", importButton);
              }
            }
          });
          roomStatus.append(" ", importButton);
        }
      }
      return;
    }
    obstacleKey = "scout-obstacles:" + roomKey(data);
    obstacles = proposedShot?.obstacles ? structuredClone(proposedShot.obstacles) : loadObstacles(data);
    if (data.label) document.querySelector("#room-title").textContent = data.label;
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
      const available = await fetch("/api/room-import-status", {signal: request.signal})
        .then(reply => reply.ok ? reply.json() : {}).catch(() => ({}));
      if (!request.signal.aborted) importMesh.hidden = !available.configured;
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
  const scale = Math.min((canvas.width - 120) / width, (canvas.height - 120) / depth);
  const context = canvas.getContext("2d");
  canvas.hidden = false;
  toWorld = event => {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width * canvas.width;
    const z = (event.clientY - box.top) / box.height * canvas.height;
    return [left + (x - (canvas.width - width * scale) / 2) / scale,
      top + (z - (canvas.height - depth * scale) / 2) / scale];
  };
  drawPlan = pose => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate((canvas.width - width * scale) / 2, (canvas.height - depth * scale) / 2);
    const coords = ([x, z]) => [(x - left) * scale, (z - top) * scale];
    context.beginPath();
    points.forEach((point, index) => context[index ? "lineTo" : "moveTo"](...coords(point)));
    context.closePath();
    context.fillStyle = "#354844";
    context.fill();
    context.strokeStyle = "#83b3a4";
    context.lineWidth = 3;
    context.stroke();
    for (const [a, b] of [...obstacles.map(obstacle => [obstacle.min, obstacle.max]), ...(draft ? [draft] : [])]) {
      const [x, z] = coords(a), [endX, endZ] = coords(b);
      context.fillStyle = "#a35449a8";
      context.strokeStyle = "#ff9c92";
      context.fillRect(x, z, endX - x, endZ - z);
      context.strokeRect(x, z, endX - x, endZ - z);
    }
    if (pose) {
      context.beginPath();
      context.moveTo(...coords(pose.from));
      context.lineTo(...coords(pose.to));
      context.strokeStyle = document.querySelector("#clearance").dataset.result === "fail"
        ? "#ff8b82" : "#f1b87b";
      context.lineWidth = 5;
      context.stroke();
      context.beginPath();
      context.moveTo(...coords([pose.x, pose.z]));
      context.lineTo(...coords([pose.tx, pose.tz]));
      context.setLineDash([6, 6]);
      context.lineWidth = 2;
      context.stroke();
      context.setLineDash([]);
      const [aimX, aimZ] = coords([pose.tx, pose.tz]);
      context.strokeRect(aimX - 6, aimZ - 6, 12, 12);
      if (Math.hypot(pose.to[0] - pose.from[0], pose.to[1] - pose.from[1]) > .01) {
        context.fillStyle = "#f4d9b8";
        context.font = "bold 15px system-ui";
        for (const [label, point] of [["START", pose.from], ["END", pose.to]]) {
          const [x, y] = coords(point);
          context.fillRect(x - 3, y - 3, 6, 6);
          context.fillText(label, x + 8, y - 9);
        }
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
  roomStatus.textContent = source + " · " + width.toFixed(2) + " m × " +
    depth.toFixed(2) + " m bounds · " + outlineMeasurements(points).area.toFixed(1) +
    " m² outline area · " + room.modelId;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const filters = new URLSearchParams(new FormData(form));
  if (![...filters.values()].some(value => value.trim())) {
    status.textContent = "Enter a search term or select a filter.";
    return;
  }
  const button = form.querySelector("button");
  button.disabled = true;
  status.textContent = "Searching the local catalog…";
  try {
    const response = await fetch("/api/locations?" + filters);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Search API failed");
    const {rows, mode, scanReadiness} = data;
    results.replaceChildren(...rows.map(row => card(row, scanReadiness)));
    const coverage = mode === "addresses" ? " · CoStar addresses and scan links only" : "";
    status.textContent = (rows.length ? rows.length + " property matches shown" : "No matching properties.") + coverage;
  } catch (error) {
    results.replaceChildren();
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
      const label = item.room.label || item.room.modelId;
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
}

function renderHistory() {
  projectHistory.hidden = !revisionHistory.length;
  projectHistory.querySelector("ol").replaceChildren(...revisionHistory.map(item => {
    const entry = element("li", item.brief + " · " + (item.selection?.label || "Room"));
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
  return {modelId, roomId, label, shot: currentShot()};
}

async function restoreSelection(selection) {
  if (selection) return inspectRoom({name: selection.label || selection.modelId},
    selection.modelId, selection.roomId, selection.shot);
  roomRequest?.abort();
  measuredRoom.hidden = true;
  uploadMesh.hidden = true;
  importMesh.hidden = true;
  importMesh.disabled = retryMesh.disabled = false;
  selectedRoom = undefined;
  closeMesh();
  roomPicker.hidden = canvas.hidden = capture.hidden = tools.hidden = true;
  drawPlan = toWorld = pose = undefined;
  document.querySelector("#room-title").textContent = "Room plan";
  roomStatus.textContent = "Select a linked scan to inspect its imported geometry.";
  const url = new URL(location.href);
  for (const field of ["model", "room", "name"]) url.searchParams.delete(field);
  history.replaceState(null, "", url);
  return true;
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
  results.replaceChildren();
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
    results.replaceChildren();
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
    constraints.allowImport ? "Matterport outline imports allowed for this run." : "",
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
  button.disabled = true;
  agentEvidence.replaceChildren();
  agentActivity.replaceChildren();
  agentResult.textContent = "Investigating the shot…";
  try {
    const prior = initialRoom
      ? " Current editor: " + (initialRoom.label || initialRoom.modelId) +
        " (model " + initialRoom.modelId + "). Lens: " + document.querySelector("#lens").value + " mm."
      : "";
    agentResult.textContent = await runAgent(constraints.brief + prior, {
      ...constraints,
      currentModel: initialRoom?.modelId,
      current: previousShot && {lens: previousShot.lens, travel: previousShot.travel,
        sensorWidthMm: previousShot.sensorWidthMm, cameraHeight: previousShot.cameraHeight, rigRadius: previousShot.rigRadius,
        durationSeconds: previousShot.durationSeconds,
        moveKind: previousShot.moveKind, keepMark: previousShot.keepMark, requireSightlines: previousShot.requireSightlines},
      revise: request => {
        if (initialRoom !== selectedRoom || initialShot !== JSON.stringify(currentShot()))
          throw Error("The open setup changed during scouting.");
        return planCurrentShot(request);
      },
      onEvidence: ({candidates, unverifiedLeads, recommended, queued}) => {
        agentEvidence.replaceChildren();
        if (candidates.length) {
          const list = element("ol", "");
          for (const candidate of candidates) {
            const {id, label, model, status, outcome, unmet, travel, requested,
              clearanceMargin, framingMargin, sightlinesSampled} = candidate;
            const entry = element("li", "");
            entry.dataset.candidate = id;
            entry.append(element("strong", [label || model || id,
              id === recommended ? "Top technical match" : status,
              id === queued ? "Selected proposal" : ""].filter(Boolean).join(" · ")));
            entry.append(element("p", outcome));
            const measurements = [
              Number.isFinite(travel) ? travel.toFixed(2) + " m of " + requested.toFixed(2) + " m requested" : "",
              Number.isFinite(clearanceMargin) ? Math.floor(clearanceMargin * 100) + " cm beyond rig radius" : "",
              Number.isFinite(framingMargin) ? Math.floor(framingMargin * 100) + "% frame margin" : "",
              Number.isFinite(travel) ? (sightlinesSampled ? "Sampled sightlines clear" : "Sightlines unverified") : "",
            ].filter(Boolean);
            if (measurements.length) entry.append(element("p", measurements.join(" · ")));
            if (unmet.length) entry.append(element("p", "Unmet requirements · " + unmet.join(", ")));
            list.append(entry);
          }
          agentEvidence.append(element("h3", "Tested setups"), list);
        }
        if (unverifiedLeads.length) {
          const list = element("ul", "");
          for (const lead of unverifiedLeads) {
            const entry = element("li", [lead.name, lead.city,
              lead.models.length ? "Room outline needed" : "No linked scan"].filter(Boolean).join(" · "));
            if (lead.evidence) entry.append(element("p", lead.evidence));
            for (const scan of lead.scans) {
              const open = element("button", "Inspect " + (scan.caption || scan.model));
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
            const opening = inspectRoom({name: room.label || room.modelId}, room.modelId, room.roomId, setup);
            const request = roomRequest;
            try {
              const opened = await opening;
              if (request === roomRequest && !request.signal.aborted)
                agentResult.textContent = opened ? "Opened " + id + " for review." : "Could not open " + id + ".";
            } finally {
              open.disabled = false;
            }
          });
          entry.append(open);
        }
      },
      activity: text => agentActivity.append(element("li", text)),
      apply: async (room, setup) => {
        if (initialRoom !== selectedRoom || initialShot !== JSON.stringify(currentShot()))
          throw Error("The open setup changed during scouting. Your changes were kept.");
        if (!room) {
          applyCurrentShot(setup);
          applied = true;
          previousRoom = {...initialRoom, proposedShot: previousShot};
          undoAgent.hidden = false;
          return;
        }
        const opening = inspectRoom({name: room.label || room.modelId}, room.modelId, room.roomId, setup);
        const proposalRequest = roomRequest;
        const opened = await opening;
        if (proposalRequest !== roomRequest || proposalRequest.signal.aborted)
          throw Error("The room changed while the proposal was opening. Your selection was kept.");
        if (!opened) {
          await restoreSelection(initialRoom ? {
            label: initialRoom.label, modelId: initialRoom.modelId, roomId: initialRoom.roomId,
            shot: previousShot || initialRoom.proposedShot,
          } : null);
          throw Error("Could not open the proposed shot.");
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
