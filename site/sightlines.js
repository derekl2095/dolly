import {actorHeight, defaultActorHeight, furnitureHeight, standIn} from "./room-state.js";

export function alignMesh(mesh, room) {
  if (room.matterpakUp !== "y") {
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.y = -1;
  }
  mesh.position.y = -(room.matterpakFloorHeight || 0);
  mesh.updateMatrixWorld(true);
}

function sampleSightlines(actors, cameraHeight, actorHeights, trace) {
  return (from, to, pointAt = t => from.map((value, index) => value + (to[index] - value) * t)) => {
    for (const t of [0, .25, .5, .75, 1]) {
      const [x, z] = pointAt(t);
      for (const [index, actor] of actors.entries()) {
        if (!actor) continue;
        const [ax, az] = actor;
        const eye = standIn.eyeHeight * actorHeight(actorHeights, index) / defaultActorHeight;
        const origin = [x, cameraHeight, z];
        const delta = [ax - x, eye - cameraHeight, az - z];
        const distance = Math.hypot(...delta);
        if (distance <= .17) continue;
        const feature = trace(origin, delta.map(value => value / distance), .03, distance - .14);
        if (feature) return {actor: index + 1, t, ...feature};
      }
    }
    return null;
  };
}

export function sightlineCheck(THREE, mesh, actors, cameraHeight, actorHeights) {
  const ray = new THREE.Raycaster();
  return sampleSightlines(actors, cameraHeight, actorHeights, (origin, direction, near, far) => {
    ray.near = near;
    ray.far = far;
    ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
    return ray.intersectObject(mesh, true).length ? {} : null;
  });
}

function intersectsBox(origin, direction, min, max, near, far) {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    const a = (min[axis] - origin[axis]) / direction[axis];
    const b = (max[axis] - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (far < near) return false;
  }
  return true;
}

export function furnitureSightlineCheck(actors, cameraHeight, actorHeights, obstacles) {
  const boxes = obstacles.flatMap(item => {
    const height = furnitureHeight(item);
    return height > 0 ? [{min: [item.min[0], 0, item.min[1]],
      max: [item.max[0], height, item.max[1]], name: item.name}] : [];
  });
  if (!boxes.length) return () => null;
  return sampleSightlines(actors, cameraHeight, actorHeights, (origin, direction, near, far) => {
    const hit = boxes.find(box => intersectsBox(origin, direction, box.min, box.max, near, far));
    return hit ? {source: "furniture", name: hit.name} : null;
  });
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
      check: (actors, height, actorHeights) => sightlineCheck(THREE, mesh, actors, height, actorHeights),
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
