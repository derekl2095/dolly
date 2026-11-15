import {actorHeight, defaultActorHeight, standIn} from "./room-state.js";
import {activeApertures, createRelight, glazingDepth} from "./relight.js?v=window-texture";
import {scanWindowCandidates} from "./window-detection.js?v=window-frame-review";
async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Daylight request failed.");
  return data;
}

const viable = verdict => ["clear-in-coverage", "exterior-unknown"].includes(verdict.status);

export function interiorStudy(THREE, mesh, profile, frame, actors, {projectPatch = true} = {}) {
  const towardSun = new THREE.Vector3(...frame.sun.direction);
  const inward = towardSun.clone().negate();
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const triangles = [];
  const floorTriangles = [];
  const exposure = actors.map(() => ({lit: false, conditional: false}));
  const projected = new Set();
  for (const {window, verdict} of activeApertures(profile, frame)) {
    const corners = window.corners.map(point => new THREE.Vector3(...point));
    const [a, b, c, d] = corners;
    const normal = window.outward ? new THREE.Vector3(...window.outward)
      : b.clone().sub(a).cross(d.clone().sub(a)).normalize();
    const incidence = normal.dot(towardSun);
    if (incidence <= .0001) continue;
    const testPoint = new THREE.Vector3(), side = new THREE.Vector3();
    const edges = corners.map((point, i) => corners[(i + 1) % 4].clone().sub(point));
    function glazing(point) {
      const separation = testPoint.copy(point).sub(a).dot(normal);
      if (separation < -glazingDepth.inside || separation > glazingDepth.outside) return false;
      let positive = true, negative = true;
      for (let i = 0; i < corners.length; i++) {
        const sign = side.copy(point).sub(corners[i]).cross(edges[i]).dot(normal);
        positive &&= sign >= -.0001;
        negative &&= sign <= .0001;
      }
      return positive || negative;
    }
    function cast(origin, direction, near, far) {
      ray.set(origin, direction);
      ray.near = near;
      ray.far = far;
      while (ray.near < far) {
        const hit = ray.intersectObject(mesh, true)[0];
        if (!hit || !glazing(hit.point)) return hit;
        ray.near = hit.distance + .0005;
      }
      return undefined;
    }
    actors.forEach((actor, index) => {
      const distance = verdict.actorApertureMeters[index];
      if (Number.isFinite(distance) && !cast(new THREE.Vector3(...actor), towardSun, .001, distance)) {
        const conditional = verdict.status === "exterior-unknown";
        exposure[index].conditional = exposure[index].lit
          ? exposure[index].conditional && conditional : conditional;
        exposure[index].lit = true;
      }
    });
    const key = JSON.stringify(window.corners);
    if (!projectPatch || projected.has(key)) continue;
    projected.add(key);
    const size = 10;
    const startOffset = Math.min(2, (glazingDepth.outside + .002) / incidence);
    const hit = (u, v) => {
      const origin = a.clone().lerp(b, u).lerp(d.clone().lerp(c, u), v).addScaledVector(towardSun, startOffset);
      return cast(origin, inward, .001, 100)?.point;
    };
    const lattice = Array.from({length: size + 1}, (_, row) =>
      Array.from({length: size + 1}, (_, col) => hit(col / size, row / size)));
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const p = lattice[row][col], q = lattice[row][col+1];
        const r = lattice[row+1][col+1], s = lattice[row+1][col];
        for (const points of [[p, q, r], [p, r, s]]) {
          if (points.every(Boolean) && points[0].distanceTo(points[1]) < .7 &&
              points[1].distanceTo(points[2]) < .7 && points[2].distanceTo(points[0]) < .7) {
            triangles.push(...points.flatMap(point => point.toArray()));
            if (points.every(point => Math.abs(point.y) < .12))
              floorTriangles.push(points.map(point => [point.x, point.z]));
          }
        }
      }
    }
  }
  return {triangles, floorTriangles, exposure};
}

export function findWindowWall(THREE, outline, ray) {
  const winding = Math.sign(outline.reduce((area, [x, z], i) => {
    const [u, v] = outline[(i + 1) % outline.length];
    return area + x * v - z * u;
  }, 0));
  let closest;
  for (const [i, [x, z]] of outline.entries()) {
    const [u, v] = outline[(i + 1) % outline.length];
    const edge = new THREE.Vector3(u - x, 0, v - z);
    const length = edge.length();
    if (length < .01) continue;
    const outward = new THREE.Vector3(edge.z, 0, -edge.x).multiplyScalar(winding / length);
    if (outward.dot(ray.direction) <= .001) continue;
    const start = new THREE.Vector3(x, 0, z);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(outward, start);
    const point = ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) continue;
    const offset = point.clone().sub(start).dot(edge) / length;
    if (offset < -.04 || offset > length + .04) continue;
    const distance = point.distanceTo(ray.origin);
    if (!closest || distance < closest.distance) closest = {plane, outward, distance};
  }
  return closest;
}

function showCandidateEvidence(row, candidate, signal, label = "Inspect wall image") {
  const {size, frameWidth, frameHeight, box, pixels} = candidate.preview ?? {};
  if (!pixels) return;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.querySelector("img")) return;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(160, Math.round(240 * frameWidth / frameHeight));
    canvas.height = 240;
    const source = document.createElement("canvas");
    source.width = source.height = size;
    const sourceContext = source.getContext("2d"), context = canvas.getContext("2d");
    if (!sourceContext || !context) return;
    const image = sourceContext.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const offset = (size - 1 - y) * size * 4;
      image.data.set(pixels.subarray(offset, offset + size * 4), y * size * 4);
    }
    sourceContext.putImageData(image, 0, 0);
    const sx = canvas.width / size, sy = canvas.height / size;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (box) {
      context.strokeStyle = "#59e8ff";
      context.lineWidth = 2;
      context.strokeRect(box.x * sx, (size - box.top) * sy, (box.right - box.x) * sx, (box.top - box.y) * sy);
    }
    const preview = document.createElement("img");
    preview.className = "window-evidence-image";
    preview.alt = box ? "Photographed wall with this candidate outlined in cyan" : label;
    preview.src = canvas.toDataURL();
    details.append(preview);
  }, {signal});
  row.append(details);
}

export function mountDaylight({THREE, room, mesh, scene, renderer, fill, marks, isAligned, canvas, camera, signal, actors, actorHeights, render, showFloorPatch}) {
  const panel = document.querySelector("#daylight");
  const frames = new Map();
  let acceleration;
  let scheduled = 0;
  const form = panel.querySelector("form");
  const help = panel.querySelector("#daylight-help");
  const status = panel.querySelector('[role="status"]');
  const clock = panel.querySelector('input[type="range"]');
  const show = panel.querySelector('[name="show"]');
  const appearance = form.elements.appearance;
  const relight = createRelight(THREE, mesh, fill, scene, renderer, marks, room);
  canvas.addEventListener("actorstagechange", relight.syncActors, {signal});
  const pick = panel.querySelector('[name="pick"]');
  const session = {model: room.modelId, room: room.roomId ?? null};
  const params = new URLSearchParams({model: session.model});
  if (session.room !== null) params.set("room", session.room);
  const patch = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: 0xffca70, transparent: true, opacity: .68, side: THREE.DoubleSide,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  patch.renderOrder = 2;
  scene.add(patch);
  patch.visible = false;
  let saved;
  let study;
  let staged = [];
  let markingWall;
  let pending;
  let ready = false;
  const listen = {signal};
  panel.hidden = false;
  status.textContent = "";
  panel.querySelector("#daylight-location-source").textContent = "";
  const headingSource = panel.querySelector("#daylight-heading-source");
  headingSource.textContent = "";
  form.reset();
  const save = form.querySelector('button[type="submit"]');
  save.disabled = appearance.disabled = show.disabled = clock.disabled = true;

  form.elements.windows.value = "[]";
  clock.value = "48";

  const detect = panel.querySelector("#detect-windows");
  const suggestions = panel.querySelector("#window-candidates");
  const previews = new THREE.Group();
  const measured = new THREE.Group();
  const markers = new THREE.Group();
  scene.add(markers);
  const showBoxes = form.elements.showWindows;
  const markedWindows = panel.querySelector("#marked-windows");
  markedWindows.replaceChildren();
  scene.add(previews, measured);
  suggestions.replaceChildren();
  detect.disabled = pick.disabled = true;
  let generation = 0;

  let lineModules;
  function windowLines() {
    return lineModules ??= Promise.all([
      import("three/addons/lines/Line2.js"),
      import("three/addons/lines/LineGeometry.js"),
      import("three/addons/lines/LineMaterial.js"),
    ]);
  }

  function clearBoxes(group) {
    for (const box of [...group.children]) {
      box.traverse(object => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      group.remove(box);
    }
  }

  function clearSuggestions() {
    clearBoxes(previews);
    suggestions.replaceChildren();
  }

  function drawBox(group, corners, color, [{Line2}, {LineGeometry}, {LineMaterial}]) {
    const box = new THREE.Group();
    const path = [...corners, corners[0]].flat();
    for (const [stroke, width, order] of [[0x101318, 7, 12], [color, 3, 13]]) {
      const geometry = new LineGeometry().setPositions(path);
      const line = new Line2(geometry, new LineMaterial({
        color: stroke, linewidth: width, depthTest: false, depthWrite: false, toneMapped: false,
      }));
      line.onBeforeRender = renderer => renderer.getSize(line.material.resolution);
      line.renderOrder = order;
      box.add(line);
    }
    const cornerGeometry = new THREE.BufferGeometry();
    cornerGeometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
    const dots = new THREE.Points(cornerGeometry, new THREE.PointsMaterial({
      color, size: 8, sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    dots.renderOrder = 14;
    box.add(dots);
    group.add(box);
    return box;
  }

  function listMarked(windows) {
    markedWindows.replaceChildren();
    for (const window of windows) {
      if (typeof window?.id !== "string") continue;
      const row = document.createElement("li");
      row.textContent = window.id + " · " + (window.source || "Marked window") + " ";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove " + window.id;
      remove.addEventListener("click", () => {
        try {
          const current = JSON.parse(form.elements.windows.value);
          form.elements.windows.value = JSON.stringify(current.filter(item => item.id !== window.id), null, 2);
          status.textContent = "Removed " + window.id + " from the draft. Save to update the sunlight study.";
          void showMeasured();
        } catch {
          status.textContent = "Fix the window measurements before removing a window.";
        }
      }, listen);
      row.append(remove);
      markedWindows.append(row);
    }
  }

  async function showMeasured() {
    clearBoxes(measured);
    try {
      const windows = JSON.parse(form.elements.windows.value);
      if (!Array.isArray(windows)) return;
      listMarked(windows);
      if (!showBoxes.checked) {
        render();
        return;
      }
      const modules = await windowLines();
      if (signal.aborted || !showBoxes.checked) return;
      clearBoxes(measured);
      for (const window of windows) {
        const corners = window?.corners;
        if (Array.isArray(corners) && corners.length === 4 && corners.every(point =>
          Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)))
          drawBox(measured, corners, 0xffce67, modules);
      }
      render();
    } catch {
      if (!signal.aborted) status.textContent = "Could not draw the marked windows. Check the window measurements.";
    }
  }

  showBoxes.addEventListener("change", showMeasured, listen);
  form.elements.windows.addEventListener("change", showMeasured, listen);

  detect.addEventListener("click", async () => {
    if (!isAligned()) {
      status.textContent = "Review the MatterPak alignment before detecting windows.";
      return;
    }
    const attempt = ++generation;
    clearSuggestions();
    detect.disabled = true;
    status.textContent = "Looking for window candidates…";
    try {
      let openings = [];
      try {
        const data = await request("/api/window-candidates", {method: "POST",
          headers: {"Content-Type": "application/json"}, body: JSON.stringify(session), signal});
        openings = data.candidates ?? [];
      } catch { /* The local scan can still suggest windows without remote metadata. */ }
      if (signal.aborted || attempt !== generation) return;
      const scanned = scanWindowCandidates(THREE, room, mesh, renderer, relight.photoMaterial, openings);
      const candidates = scanned.length ? [...scanned] : openings;
      const declined = scanned.rejected || [];
      const modules = candidates.length || declined.length ? await windowLines() : null;
      if (signal.aborted || attempt !== generation) return;
      const weak = document.createElement("details");
      const weakTitle = document.createElement("summary");
      const weakList = document.createElement("ul");
      weak.append(weakTitle, weakList);
      let weakCount = 0;
      candidates.forEach((candidate, index) => {
        const {corners, outward, source} = candidate;
        const weakEvidence = candidate.openingEvidence === false;
        if (weakEvidence) weakCount++;
        const outline = drawBox(previews, corners, weakEvidence ? 0x9e92ad : 0x59e8ff, modules);
        outline.visible = !weakEvidence;
        if (weakEvidence) weak.addEventListener("toggle", () => {
          outline.visible = weak.open;
          render();
        }, listen);
        const row = document.createElement("li");
        row.append(document.createTextNode("Window candidate " + (index+1) + " · " + source + " "));
        function remove() {
          outline.traverse(object => {
            object.geometry?.dispose();
            object.material?.dispose();
          });
          previews.remove(outline);
          row.remove();
          render();
        }
        for (const [label, action] of [["Use candidate", () => {
          try {
            const windows = JSON.parse(form.elements.windows.value);
            let id = 1;
            while (windows.some(window => window.id === "window-" + id)) id++;
            windows.push({id: "window-" + id, corners, outward, source});
            form.elements.windows.value = JSON.stringify(windows, null, 2);
            showBoxes.checked = true;
            void showMeasured();
            status.textContent = "Candidate added. Confirm this is exterior glazing, adjust measurements if needed, then save.";
            remove();
          } catch {
            status.textContent = "Fix the window measurements before adding a candidate.";
          }
        }], ["Discard", remove]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.addEventListener("click", action, listen);
          row.append(button);
        }
        showCandidateEvidence(row, candidate, signal);
        (weakEvidence ? weakList : suggestions).append(row);
      });
      if (weakCount) {
        weakTitle.textContent = `Review ${weakCount} texture-only ${weakCount === 1 ? "possibility" : "possibilities"}`;
        const item = document.createElement("li");
        item.append(weak);
        suggestions.append(item);
      }
      declined.forEach(candidate => {
        if (!candidate.corners) return;
        drawBox(previews, candidate.corners, 0xc47a4a, modules);
        const row = document.createElement("li");
        row.textContent = candidate.source || candidate.reason;
        suggestions.append(row);
      });
      if (scanned.wallViews?.length) {
        const wallReview = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Review scanned walls";
        wallReview.append(summary);
        scanned.wallViews.forEach((preview, i) => showCandidateEvidence(wallReview, {preview}, signal, `Wall ${i + 1}`));
        const row = document.createElement("li");
        row.append(wallReview);
        suggestions.append(row);
      }
      status.textContent = candidates.length
        ? `${candidates.length - weakCount} supported openings${weakCount ? ` · ${weakCount} texture-only suggestions` : ""}. Confirm exterior glazing before saving.`
        : "No framed openings found. Clear or fully scanned glass may need four corners marked manually.";
      render();
    } catch (error) {
      if (!signal.aborted && attempt === generation) status.textContent = error.message;
    } finally {
      if (!signal.aborted && attempt === generation) detect.disabled = false;
    }
  }, listen);

  const wantsStudy = () => show.checked || appearance.value === "relit";

  function update() {
    const frame = wantsStudy() && study?.frames?.[Number(clock.value)];
    const relit = appearance.value === "relit" && Boolean(frame);
    relight.set(relit ? frame : null, saved?.profile);
    show.disabled = !ready;
    if (!frame) {
      patch.visible = false;
      showFloorPatch([]);
      render();
      return;
    }
    const index = Number(clock.value);
    const projectPatch = show.checked;
    const key = 2 * index + Number(projectPatch);
    if (!frames.has(key)) frames.set(key,
      interiorStudy(THREE, mesh, saved.profile, frame, study.actors, {projectPatch}));
    const {triangles, floorTriangles, exposure} = frames.get(key);
    showFloorPatch(projectPatch ? floorTriangles : []);
    if (projectPatch && !relit && patch.userData.frame !== triangles) {
      patch.geometry.dispose();
      patch.geometry = new THREE.BufferGeometry();
      patch.geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
      patch.userData.frame = triangles;
    }
    patch.visible = projectPatch && !relit && triangles.length !== 0;
    const assumed = frame.windows.some(w => w.status === "exterior-unknown");
    status.textContent = frame.localTime + " · " + frame.windows.map(w => w.id + " " + w.reason).join(" · ") +
      (assumed ? " · assuming unobstructed sun" : "") +
      (projectPatch && !triangles.length ? " · No interior surface patch found at this time." : "") +
      exposure.map(({lit, conditional}, i) => " · Actor " + study.indices[i] + " " +
        (lit ? (conditional ? "potential direct sun" : "direct sun") : "outside the evaluated beams")).join("");
    render();
  }

  let headingLookup;
  function updateHelp() {
    const missing = [
      ...(["latitude", "longitude", "timeZone"].some(key => !form.elements[key].value) ? ["site coordinates and time zone"] : []),
      ...(!form.elements.heading.value ? ["true-north bearing"] : []),
      ...(!saved.profile?.windows?.length ? ["a confirmed exterior window"] : []),
    ];
    help.textContent = !saved.revision ? "First use Inspect mesh alignment and save the review." :
      missing.length ? "To start, add " + missing.join(", ") + ". Then save to show direct sunlight." :
      "The overlay estimates direct sun over the photographed scan.";
  }
  async function fillHeading() {
    const field = form.elements.heading;
    if (!saved || !panel.open || field.value !== "" || headingLookup) return;
    headingSource.textContent = "Checking Matterport for true north…";
    headingLookup = request("/api/room-heading?" + params, {signal});
    try {
      const result = await headingLookup;
      if (signal.aborted || field.value !== "") return;
      if (result.status === "ready") {
        field.value = result.heading;
        headingSource.textContent = "Filled from " + result.source + ".";
        updateHelp();
      } else {
        headingSource.textContent = result.reason + " Enter a verified bearing to continue.";
      }
    } catch (error) {
      if (!signal.aborted && field.value === "") headingSource.textContent = error.message;
    }
  }
  panel.addEventListener("toggle", fillHeading, listen);
  form.elements.heading.addEventListener("input", () => {
    headingSource.textContent = "";
    if (saved) updateHelp();
  }, listen);

  async function load() {
    const loaded = await request("/api/room-lighting?" + params, {signal});
    if (signal.aborted) return;
    saved = loaded;
    if (saved.profile) {
      for (const key of ["latitude", "longitude", "heading", "timeZone"]) form.elements[key].value = saved.profile[key];
      form.elements.windows.value = JSON.stringify(saved.profile.windows, null, 2);
      void showMeasured();
    }
    const site = saved.locationDefaults;
    const defaults = [];
    for (const [key, label] of [["latitude", "latitude"], ["longitude", "longitude"], ["timeZone", "market time zone"], ["heading", "plan +Z bearing"]]) {
      if (site?.[key] != null && form.elements[key].value === "") {
        form.elements[key].value = site[key];
        defaults.push(label);
      }
    }
    const headingMissing = site && site.heading == null && form.elements.heading.value === "";
    panel.querySelector("#daylight-location-source").textContent = defaults.length
      ? "Filled " + defaults.join(", ") + " from CoStar property " + site.propertyId + "." +
        (headingMissing ? " The plan's +Z bearing is not in that CoStar record." : "")
      : "";
    if (!form.elements.date.value) {
      const zone = form.elements.timeZone.value || undefined;
      const parts = new Intl.DateTimeFormat("en", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts();
      const part = type => parts.find(item => item.type === type).value;
      form.elements.date.value = [part("year"), part("month"), part("day")].join("-");
    }
    ready = saved.status === "ready";
    save.disabled = detect.disabled = pick.disabled = !saved.revision;
    appearance.disabled = show.disabled = clock.disabled = !ready;
    updateHelp();
    void fillHeading();
    if (ready) show.checked = true;
    status.textContent = saved.status === "ready" ? "Daylight calibration ready."
      : saved.status === "stale" ? "Review and resave the daylight calibration for this mesh."
      : "Add a measured window and confirm true north.";
  }

  async function evaluate() {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    if ((!panel.open && appearance.value !== "relit") || !wantsStudy() || !ready) {
      study = null;
      update();
      return;
    }
    const positions = actors().map((point, i) => point && {index: i + 1, point: [point[0], standIn.eyeHeight * actorHeight(actorHeights?.(), i) / defaultActorHeight, point[1]]}).filter(Boolean);
    try {
      const values = positions.map(item => item.point);
      const result = await request("/api/daylight-study", {
        method: "POST", headers: {"Content-Type": "application/json"}, signal: controller.signal,
        body: JSON.stringify({...session, localDate: form.elements.date.value, actors: values}),
      });
      if (signal.aborted || controller.signal.aborted) return;
      if (result.frames.some(frame => frame.windows.some(viable))) {
        status.textContent = "Preparing the sunlight preview…";
        acceleration ??= import("three-mesh-bvh").then(({MeshBVH, acceleratedRaycast}) => {
          if (signal.aborted) return;
          mesh.traverse(object => {
            if (!object.isMesh) return;
            object.geometry.boundsTree ??= new MeshBVH(object.geometry, {indirect: true});
            object.raycast = acceleratedRaycast;
          });
        }).catch(() => { /* Keep the standard Three.js raycaster as a fallback. */ });
        await acceleration;
        if (signal.aborted || controller.signal.aborted) return;
      }
      frames.clear();
      clock.max = Math.max(0, result.frames.length - 1);
      study = {...result, actors: values, indices: positions.map(item => item.index)};
      update();
      if (!result.frames.length) status.textContent = result.reason;
    } catch (error) {
      if (!controller.signal.aborted && !signal.aborted) {
        study = null;
        update();
        status.textContent = error.message;
      }
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      // Reuse the revision shown when editing to reject stale calibrations.
      const profile = Object.fromEntries(["latitude", "longitude", "heading"].map(key => [key, Number(form.elements[key].value)]));
      profile.timeZone = form.elements.timeZone.value.trim();
      profile.windows = JSON.parse(form.elements.windows.value);
      saved = await request("/api/room-lighting", {method: "PUT", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({...session, revision: saved?.revision, profile}), signal});
      ready = true;
      appearance.disabled = show.disabled = clock.disabled = false;
      show.checked = true;
      help.textContent = "The overlay estimates direct sun over the photographed scan.";
      status.textContent = "Daylight calibration saved.";
      void evaluate();
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message;
    } finally {
      if (!signal.aborted) save.disabled = false;
    }
  }, listen);
  canvas.addEventListener("click", event => {
    if (!pick.checked) return;
    const bounds = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
      1 - (event.clientY - bounds.top) / bounds.height * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera());
    if (!markingWall) markingWall = findWindowWall(THREE, room.outline, ray.ray);
    const point = markingWall && ray.ray.intersectPlane(markingWall.plane, new THREE.Vector3());
    if (!point || point.y < -.05 || point.y > (room.height || 3.5) + .3) {
      status.textContent = "Choose a corner on a visible room wall. Click the sill first.";
      return;
    }
    staged.push(point.toArray().map(value => Math.round(value * 10000) / 10000));
    const marker = new THREE.Points(new THREE.BufferGeometry().setFromPoints([point]),
      new THREE.PointsMaterial({color: 0xffce67, size: 10, sizeAttenuation: false, depthTest: false}));
    marker.renderOrder = 15;
    markers.add(marker);
    render();
    status.textContent = "Picked " + staged.length + " of 4 corners.";
    if (staged.length !== 4) return;
    pick.checked = false;
    const corners = staged;
    const outward = markingWall.outward.toArray();
    resetPicking();
    try {
      const windows = JSON.parse(form.elements.windows.value);
      let id = 1;
      while (windows.some(window => window.id === "window-" + id)) id++;
      windows.push({id: "window-" + id, corners, outward, source: "Operator marked on aligned room wall"});
      form.elements.windows.value = JSON.stringify(windows, null, 2);
      showBoxes.checked = true;
      void showMeasured();
      status.textContent = "Window added to the draft. Check the gold box and save when it matches the frame.";
    } catch {
      status.textContent = "Fix the window JSON before adding picked corners.";
    }
  }, listen);
  function resetPicking() {
    staged = [];
    markingWall = null;
    clearBoxes(markers);
  }
  pick.addEventListener("change", () => {
    resetPicking();
    if (pick.checked) status.textContent = "Click four corners around one pane in order, starting at the sill.";
    render();
  }, listen);
  show.addEventListener("change", () => {
    if (study?.frames?.length) update();
    else void evaluate();
  }, listen);
  appearance.addEventListener("change", () => {
    show.checked = appearance.value !== "relit";
    if (study?.frames?.length) update();
    else void evaluate();
  }, listen);
  form.elements.date.addEventListener("change", evaluate, listen);
  panel.addEventListener("toggle", evaluate, listen);
  clock.addEventListener("input", () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      update();
    });
  }, listen);
  signal.addEventListener("abort", () => {
    pending?.abort();
    cancelAnimationFrame(scheduled);
    showFloorPatch([]);
    clearSuggestions();
    clearBoxes(measured);
    clearBoxes(markers);
    panel.hidden = true;
    patch.geometry.dispose();
    patch.material.dispose();
    relight.dispose();
  }, {once: true});
  void load().then(evaluate).catch(error => { if (!signal.aborted) status.textContent = error.message; });
  return {
    evaluate,
    reload() {
      generation++;
      clearSuggestions();
      save.disabled = detect.disabled = pick.disabled = appearance.disabled = show.disabled = clock.disabled = true;
      ready = false;
      pending?.abort();
      study = null;
      update();
      void load().then(evaluate).catch(error => { if (!signal.aborted) status.textContent = error.message; });
    },
  };
}
