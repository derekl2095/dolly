import {loadSightlines} from "./sightlines.js";
import {actorMarks, checkCameraHeight, loadObstacles, loadShot, shotSettings} from "./room-state.js";
import {cameraMoveAxis, checkFraming, findSlide, slideEndpoints} from "./path.js";

export function compareRooms(rooms, focal, requested, moveKind = "slide", evidence = new Map(), optics) {
  const settings = {focal, aspect: 16 / 9};
  return rooms.map(room => {
    const saved = loadShot(room);
    const actors = actorMarks(room, saved);
    const camera = saved?.mark || room.camera;
    if (!camera || !actors.every(Boolean)) {
      return {room, length: -1, reason: "Two actor marks and a camera mark are needed."};
    }
    const aim = saved?.aim || room.lookAt || actors[0].map((value, index) =>
      (value + actors[1][index]) / 2);
    const cameraSettings = shotSettings(room, {...saved, ...optics});
    const ceiling = checkCameraHeight(room, cameraSettings.cameraHeight);
    if (ceiling.status === "fail")
      return {room, length: -1, ceiling, reason: "Camera height reaches or exceeds the reported room height."};
    const optical = {...settings, width: cameraSettings.sensorWidthMm, cameraHeight: cameraSettings.cameraHeight,
      aimHeight: cameraSettings.aimHeight};
    const axis = cameraMoveAxis(moveKind, camera, aim, room.slideAxis);
    const obstacles = loadObstacles(room);
    const spatial = evidence.get(room);
    const obstruction = spatial?.check?.(actors, optical.cameraHeight);
    if (spatial?.required && !obstruction)
      return {room, length: -1, reason: "Captured sightlines unknown: " + spatial.status + "."};
    const rejections = {clearance: 0, framing: 0, sightline: 0};
    let checks = 0;
    let passedClearance = 0;
    let limited = false;
    const result = findSlide(room.outline, camera, aim, axis, moveKind === "static" ? 0 : requested,
      cameraSettings.rigRadius, false, obstacles, (from, to) => {
        passedClearance++;
        if (checkFraming(from, to, aim, actors, optical).margin < 0) {
          rejections.framing++;
          return false;
        }
        if (!obstruction) return true;
        if (checks >= 8) {
          limited = true;
          return false;
        }
        checks++;
        if (!obstruction(from, to)) return true;
        rejections.sightline++;
        return false;
      });
    rejections.clearance = result.checked - passedClearance;
    const evaluation = {tested: result.checked, clearanceRejected: rejections.clearance, framingRejected: rejections.framing,
      sightlineRejected: rejections.sightline, sightlineChecks: checks, sightlineLimitReached: limited};
    if (!result.mark) {
      return {room, length: -1, evaluation, reason: limited ? "Captured sightline search reached its eight-candidate limit."
        : "No setup passed. Tested " + evaluation.tested + " setups; " +
          evaluation.clearanceRejected + " failed rig clearance, " +
          evaluation.framingRejected + " failed framing and " + evaluation.sightlineRejected +
          " hit a captured obstruction."};
    }
    const moveName = {push: "push-in", pull: "pull-back", slide: "slide"}[moveKind];
    const move = result.length ? result.length.toFixed(2) + " m " + moveName : "Static shot";
    const direction = axis || [aim[1] - result.mark[1], result.mark[0] - aim[0]];
    const [start, end] = slideEndpoints(result.mark, direction, result.length);
    const margin = checkFraming(start, end, aim, actors, optical).margin;
    return {room, length: result.length, ceiling, evaluation, clearanceMargin: result.margin, framingMargin: margin,
      markedObstacles: obstacles.length, sightlinesSampled: checks > 0, setup: {...cameraSettings, mark: result.mark, lens: focal, travel: result.length, moveKind, axis: axis || null, actors, aim, aimLocked: saved?.aimLocked === true, obstacles, requireSightlines: checks > 0}, reason: move +
      " with wall clearance and sampled framing" +
      (obstacles.length ? ", checked against " + obstacles.length + " marked furniture footprints." : ".") +
      (checks ? " Clear at five sampled eye-level scan positions." : " Captured sightlines unverified.") +
      (ceiling.status === "unknown" ? " Room height unverified." : "")};
  }).sort((a, b) => b.length - a.length || (b.clearanceMargin ?? -Infinity) - (a.clearanceMargin ?? -Infinity));
}

export async function compareCapturedRooms(rooms, focal, requested, move, requireSightlines,
                                           load = loadSightlines, optics) {
  const results = [];
  for (const room of rooms) {
    const evidence = requireSightlines ? await load(room) : {};
    try {
      results.push(compareRooms([room], focal, requested, move,
        new Map([[room, {...evidence, required: requireSightlines}]]), optics)[0]);
    } finally {
      evidence.dispose?.();
    }
  }
  return results.sort((a, b) => b.length - a.length ||
    (b.clearanceMargin ?? -Infinity) - (a.clearanceMargin ?? -Infinity));
}
