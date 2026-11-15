export function alignMesh(mesh, room) {
  if (room.matterpakUp !== "y") {
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.y = -1;
  }
  mesh.position.y = -(room.matterpakFloorHeight || 0);
  mesh.updateMatrixWorld(true);
}

export function sightlineCheck(THREE, mesh, actors, cameraHeight) {
  const ray = new THREE.Raycaster();
  ray.near = .03;
  return (from, to, pointAt = t => from.map((value, index) => value + (to[index] - value) * t)) => {
    for (const t of [0, .25, .5, .75, 1]) {
      const [x, z] = pointAt(t);
      const origin = new THREE.Vector3(x, cameraHeight, z);
      for (const [index, actor] of actors.entries()) {
        if (!actor) continue;
        const [ax, az] = actor;
        const direction = new THREE.Vector3(ax, 1.49, az).sub(origin);
        ray.far = direction.length() - .14;
        if (ray.far <= ray.near) continue;
        ray.set(origin, direction.normalize());
        if (ray.intersectObject(mesh, true).length) return {actor: index + 1, t};
      }
    }
    return null;
  };
}

export async function loadSightlines(room) {
  if (room.matterpakAlignmentVerified !== true)
    return {status: "alignment unverified"};
  const base = "/matterpak/" + encodeURIComponent(room.modelId) + "/";
  let mesh;
  try {
    const manifest = await fetch(base + "manifest.json", {signal: AbortSignal.timeout(5000)});
    if (!manifest.ok) return {status: "mesh unavailable"};
    const {obj} = await manifest.json();
    const url = base + obj.split("/").map(encodeURIComponent).join("/");
    const [THREE, {OBJLoader}, response] = await Promise.all([
      import("three"), import("three/addons/loaders/OBJLoader.js"),
      fetch(url, {signal: AbortSignal.timeout(15000)}),
    ]);
    if (!response.ok) return {status: "mesh unavailable"};
    mesh = new OBJLoader().parse(await response.text());
    alignMesh(mesh, room);
    return {status: "available",
      check: (actors, height) => sightlineCheck(THREE, mesh, actors, height),
      dispose: () => release(mesh)};
  } catch {
    if (mesh) release(mesh);
    return {status: "mesh unavailable"};
  }
}

function release(mesh) {
  const materials = new Set();
  mesh.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    for (const material of [object.material].flat()) materials.add(material);
  });
  for (const material of materials) material.dispose();
}
