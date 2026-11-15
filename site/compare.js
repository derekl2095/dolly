import {loadSightlines} from "./sightlines.js";
import {actorMarks, loadObstacles, loadShot, shotSettings} from "./room-state.js";
import {solveShot} from "./solver.js";

export function compareRooms(rooms, focal, requested, moveKind = "slide", evidence = new Map(), optics, trial) {
  return rooms.map(room => {
    const saved = loadShot(room);
    const actors = trial?.actors ?? actorMarks(room, saved);
    const camera = trial?.mark ?? (saved?.mark || room.camera);
    const aim = trial?.aim ?? (saved?.aim || room.lookAt || (actors.every(Boolean)
      ? actors[0].map((value, index) => (value + actors[1][index]) / 2) : null));
    const cameraSettings = trial?.cameraSettings ?? shotSettings(room, {...saved, ...optics});
    const obstacles = trial?.obstacles ?? loadObstacles(room);
    const aimLocked = trial?.aimLocked ?? (saved?.aimLocked === true);
    const staging = {actors, mark: camera, aim, aimLocked, cameraSettings, obstacles};
    const spatial = evidence.get(room);
    const solved = solveShot(room, {
      actors, mark: camera, aim, aimLocked, lens: focal,
      sensorWidthMm: cameraSettings.sensorWidthMm, cameraHeight: cameraSettings.cameraHeight,
      rigRadius: cameraSettings.rigRadius, aimHeight: cameraSettings.aimHeight,
      durationSeconds: cameraSettings.durationSeconds, move: moveKind,
      targetTravel: moveKind === "static" ? 0 : requested,
      minimumTravel: Number.isFinite(optics?.minimumTravel) ? optics.minimumTravel : 0,
      keepMark: Boolean(trial), obstacles,
      requireSightlines: spatial?.required === true,
      sightlineCheck: spatial?.check?.(actors, cameraSettings.cameraHeight),
      sightlineStatus: spatial?.status, sightlineLimit: 8,
    });
    const usable = solved.status === "pass" || solved.status === "fallback";
    return {room, length: usable ? solved.measurements.travel : -1, reason: solved.reason,
      ceiling: solved.ceiling, evaluation: solved.evaluation,
      clearanceMargin: solved.measurements?.clearanceMargin, framingMargin: solved.measurements?.framingMargin,
      markedObstacles: obstacles.length, sightlinesSampled: solved.setup?.requireSightlines === true,
      setup: usable ? {...cameraSettings, ...solved.setup} : null,
      status: solved.status, missedConstraint: solved.missedConstraint, label: solved.label,
      measurements: solved.measurements, missing: solved.missing, staging};
  }).sort((a, b) => b.length - a.length || (b.clearanceMargin ?? -Infinity) - (a.clearanceMargin ?? -Infinity));
}

export async function compareCapturedRooms(rooms, focal, requested, move, requireSightlines,
                                           load = loadSightlines, optics, trial) {
  const results = [];
  for (const room of rooms) {
    const evidence = requireSightlines ? await load(room) : {};
    try {
      results.push(compareRooms([room], focal, requested, move,
        new Map([[room, {...evidence, required: requireSightlines}]]), optics, trial)[0]);
    } finally {
      evidence.dispose?.();
    }
  }
  return results.sort((a, b) => b.length - a.length ||
    (b.clearanceMargin ?? -Infinity) - (a.clearanceMargin ?? -Infinity));
}
