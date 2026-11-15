export function checkCameraHeight(room, height) {
  if (!Number.isFinite(room.height) || room.height <= 0 || room.heightEstimated === true)
    return {status: "unknown", margin: null};
  const margin = room.height - height;
  return {status: margin > 0 ? "pass" : "fail", margin};
}

export function shotSettings(room, shot) {
  const bounded = (value, min, max, fallback) =>
    Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    aimHeight: bounded(shot?.aimHeight, 0, 100, bounded(room.aimHeight, 0, 100, 1.22)),
    durationSeconds: bounded(shot?.durationSeconds, .5, 30, 3.8),
    rigRadius: bounded(shot?.rigRadius, .05, 1.5, .25),
    sensorWidthMm: bounded(shot?.sensorWidthMm, 8, 65, 36),
    cameraHeight: bounded(shot?.cameraHeight, .15, 4, bounded(room.cameraHeight, .15, 4, 1.42)),
  };
}

export function roomKey(room) {
  return room.modelId + (room.roomId ? "/" + room.roomId : "");
}

export function loadObstacles(room) {
  try {
    const saved = JSON.parse(localStorage.getItem("scout-obstacles:" + roomKey(room)));
    if (Array.isArray(saved)) return saved.filter(item => item && typeof item.name === "string" &&
      [item.min, item.max].every(point => Array.isArray(point) && point.length === 2 &&
        point.every(Number.isFinite)) && item.min.every((value, index) => value < item.max[index]));
  } catch {}
  return [];
}

export const maxActors = 8;
export const standIn = Object.freeze({
  bodyRadius: .17, bodyLength: 1.03, bodyCenter: .69, headRadius: .115, eyeHeight: 1.49,
  colors: Object.freeze(["#b98c66", "#728d9f", "#819773", "#a289a5"]),
});
export const defaultFurnitureHeight = .75;

export function furnitureHeight(obstacle) {
  return Number.isFinite(obstacle.height) && obstacle.height >= 0 && obstacle.height <= 12
    ? obstacle.height : defaultFurnitureHeight;
}

export function actorMarks(room, saved) {
  const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const points = Array.isArray(saved?.actors) ? saved.actors : room.actors;
  const count = Math.max(2, Math.min(maxActors, points?.length || 0));
  return Array.from({length: count}, (_, index) => validPoint(points?.[index]) ? points[index].slice() : null);
}

export function actorCenter(actors) {
  const placed = actors.filter(Boolean);
  if (!placed.length) return null;
  return [0, 1].map(axis => placed.reduce((sum, point) => sum + point[axis], 0) / placed.length);
}

export function loadShot(room) {
  try { return JSON.parse(localStorage.getItem("scout-shot:" + roomKey(room))); } catch { return null; }
}

export function outlineMeasurements(outline) {
  const xs = outline.map(([x]) => x);
  const zs = outline.map(([, z]) => z);
  const area = Math.abs(outline.reduce((sum, [x, z], index) => {
    const [nextX, nextZ] = outline[(index + 1) % outline.length];
    return sum + x * nextZ - z * nextX;
  }, 0)) / 2;
  return {xSpan: Math.max(...xs) - Math.min(...xs), zSpan: Math.max(...zs) - Math.min(...zs), area};
}
