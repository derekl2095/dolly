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
  const cast = (origin, direction, near, far) => {
    ray.set(origin, direction);
    ray.near = near;
    ray.far = far;
    return ray.intersectObject(mesh, true)[0];
  };
  const triangles = [];
  const exposure = actors.map(() => ({lit: false, conditional: false}));
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
              points[1].distanceTo(points[2]) < .7 && points[2].distanceTo(points[0]) < .7)
            triangles.push(...points.flatMap(point => point.toArray()));
        }
      }
    }
  }
  return {triangles, exposure};
}

export function mountDaylight({THREE, room, mesh, scene, canvas, camera, signal, actors, render}) {
  const panel = document.querySelector("#daylight");
  const form = panel.querySelector("form");
  const status = panel.querySelector('[role="status"]');
  const clock = panel.querySelector('input[type="range"]');
  const show = panel.querySelector('[name="show"]');
  const pick = panel.querySelector('[name="pick"]');
  const session = {model: room.modelId, room: room.roomId ?? null};
  const params = new URLSearchParams({model: session.model});
  if (session.room !== null) params.set("room", session.room);
  const patch = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: 0xffca70, transparent: true, opacity: .43, side: THREE.DoubleSide,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  scene.add(patch);
  patch.visible = false;
  let saved;
  let study;
  let staged = [];
  let pending;
  let ready = false;
  const listen = {signal};
  panel.hidden = false;
  show.checked = false;
  pick.checked = false;
  status.textContent = "";
  form.reset();
  form.querySelector("button").disabled = false;
  form.elements.date.value = new Date().toISOString().slice(0, 10);
  form.elements.windows.value = "[]";
  clock.value = "48";

  function update() {
    if (!show.checked || !study?.frames?.length) {
      patch.visible = false;
      render();
      return;
    }
    const index = Number(clock.value);
    const frame = study.frames[index];
    if (!frame) return;
    const {triangles, exposure} = interiorStudy(THREE, mesh, saved.profile, frame, study.actors);
    patch.geometry.dispose();
    patch.geometry = new THREE.BufferGeometry();
    patch.geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
    patch.visible = triangles.length !== 0;
    const assumed = frame.windows.some(w => w.status === "exterior-unknown");
    status.textContent = frame.localTime + " · " + frame.windows.map(w => w.id + " " + w.reason).join(" · ") +
      (assumed ? " · assuming unobstructed sun" : "") +
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
    }
    ready = saved.status === "ready";
    status.textContent = saved.status === "ready" ? "Daylight calibration ready."
      : saved.status === "stale" ? "Review and resave the daylight calibration for this mesh."
      : "Add a measured window and confirm true north.";
  }

  async function evaluate() {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    if (!show.checked || !ready) {
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
    const save = form.querySelector("button");
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
    const hit = ray.intersectObject(mesh, true)[0];
    if (!hit) return;
    staged.push(hit.point.toArray().map(value => Math.round(value * 10000) / 10000));
    status.textContent = "Picked " + staged.length + " of 4 corners.";
    if (staged.length !== 4) return;
    pick.checked = false;
    const corners = staged;
    staged = [];
    try {
      const windows = JSON.parse(form.elements.windows.value);
      const [a, b, c] = corners.map(point => new THREE.Vector3(...point));
      const normal = b.sub(a).cross(c.sub(a)).normalize();
      let id = 1;
      while (windows.some(window => window.id === "window-" + id)) id++;
      windows.push({id: "window-" + id, corners, outward: normal.toArray(), source: "Operator marked on aligned MatterPak"});
      form.elements.windows.value = JSON.stringify(windows, null, 2);
      status.textContent = "Confirm the outward normal in the window measurements. Reverse its signs if it points indoors.";
    } catch {
      status.textContent = "Fix the window JSON before adding picked corners.";
    }
  }, listen);
  pick.addEventListener("change", () => { staged = []; }, listen);
  show.addEventListener("change", evaluate, listen);
  form.elements.date.addEventListener("change", evaluate, listen);
  clock.addEventListener("input", update, listen);
  signal.addEventListener("abort", () => {
    pending?.abort();
    panel.hidden = true;
    patch.geometry.dispose();
    patch.material.dispose();
  }, {once: true});
  void load().catch(error => { if (!signal.aborted) status.textContent = error.message; });
  return {
    evaluate,
    reload() {
      ready = false;
      pending?.abort();
      study = null;
      update();
      void load().then(evaluate).catch(error => { if (!signal.aborted) status.textContent = error.message; });
    },
  };
}
