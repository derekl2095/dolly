import {createRelight} from "./relight.js?v=dark-panes";
import {scanWindowCandidates} from "./window-detection.js?v=window-angles";
async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Daylight request failed.");
  return data;
}

const viable = verdict => ["clear-in-coverage", "exterior-unknown"].includes(verdict.status);

export function interiorStudy(THREE, mesh, profile, frame, actors) {
  const towardSun = new THREE.Vector3(...frame.sun.direction);
  const inward = towardSun.clone().negate();
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const cast = (origin, direction, near, far) => {
    ray.set(origin, direction);
    ray.near = near;
    ray.far = far;
    return ray.intersectObject(mesh, true)[0];
  };
  const triangles = [];
  const floorTriangles = [];
  const exposure = actors.map(() => ({lit: false, conditional: false}));
  const apertures = new Set();
  for (const verdict of frame.windows.filter(viable)) {
    const {corners} = profile.windows.find(window => window.id === verdict.id);
    const [a, b, c, d] = corners.map(point => new THREE.Vector3(...point));
    actors.forEach((actor, index) => {
      const distance = verdict.actorApertureMeters[index];
      if (distance !== null && !cast(new THREE.Vector3(...actor), towardSun, .001, Math.max(.001, distance - .03))) {
        const conditional = verdict.status === "exterior-unknown";
        exposure[index].conditional = exposure[index].lit
          ? exposure[index].conditional && conditional : conditional;
        exposure[index].lit = true;
      }
    });
    const key = JSON.stringify(corners);
    if (apertures.has(key)) continue;
    apertures.add(key);
    // Start just inside the annotated window plane to skip captured glazing there.
    const size = 10;
    const hit = (u, v) => {
      const origin = a.clone().lerp(b, u).lerp(d.clone().lerp(c, u), v);
      return cast(origin, inward, .03, 100)?.point;
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

export function mountDaylight({THREE, room, mesh, scene, renderer, fill, marks, isAligned, canvas, camera, signal, actors, render, showFloorPatch}) {
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
  const relight = createRelight(THREE, mesh, fill, scene, renderer, marks);
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
      const data = await request("/api/window-candidates", {method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify(session), signal});
      if (signal.aborted || attempt !== generation) return;
      const candidates = data.candidates.length ? data.candidates : scanWindowCandidates(THREE, room, mesh, renderer, relight.photoMaterial);
      const modules = candidates.length ? await windowLines() : null;
      if (signal.aborted || attempt !== generation) return;
      candidates.forEach((candidate, index) => {
        const {corners, outward, source} = candidate;
        const outline = drawBox(previews, corners, 0x59e8ff, modules);
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
        suggestions.append(row);
      });
      status.textContent = candidates.length ? "Review the outlined candidates against the scan."
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
    show.disabled = !ready || relit;
    if (!frame) {
      patch.visible = false;
      showFloorPatch([]);
      render();
      return;
    }
    const index = Number(clock.value);

    if (!frames.has(index)) frames.set(index, interiorStudy(THREE, mesh, saved.profile, frame, study.actors));
    const {triangles, floorTriangles, exposure} = frames.get(index);
    showFloorPatch(floorTriangles);
    patch.geometry.dispose();
    patch.geometry = new THREE.BufferGeometry();
    patch.geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
    patch.visible = !relit && triangles.length !== 0;
    const assumed = frame.windows.some(w => w.status === "exterior-unknown");
    status.textContent = frame.localTime + " · " + frame.windows.map(w => w.id + " " + w.reason).join(" · ") +
      (assumed ? " · assuming unobstructed sun" : "") +
      (!triangles.length ? " · No interior surface patch found at this time." : "") +
      exposure.map(({lit, conditional}, i) => " · Actor " + study.indices[i] + " " +
        (lit ? (conditional ? "potential direct sun" : "direct sun") : "outside the evaluated beams")).join("");
    render();
  }

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
    for (const [key, label] of [["latitude", "latitude"], ["longitude", "longitude"], ["timeZone", "market time zone"]]) {
      if (site?.[key] != null && form.elements[key].value === "") {
        form.elements[key].value = site[key];
        defaults.push(label);
      }
    }
    panel.querySelector("#daylight-location-source").textContent = defaults.length
      ? "Filled " + defaults.join(", ") + " from CoStar property " + site.propertyId + "."
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
    const missing = [
      ...(["latitude", "longitude", "timeZone"].some(key => !form.elements[key].value) ? ["site coordinates and time zone"] : []),
      ...(!form.elements.heading.value ? ["true-north bearing"] : []),
      ...(!saved.profile?.windows?.length ? ["a confirmed exterior window"] : []),
    ];
    help.textContent = !saved.revision ? "First use Inspect mesh alignment and save the review." :
      missing.length ? "To start, add " + missing.join(", ") + ". Then save to show direct sunlight." :
      "The overlay estimates direct sun over the photographed scan.";
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
    const positions = actors().map((point, i) => point && {index: i + 1, point: [point[0], 1.49, point[1]]}).filter(Boolean);
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
  show.addEventListener("change", evaluate, listen);
  appearance.addEventListener("change", () => {
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
