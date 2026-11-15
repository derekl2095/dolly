import {cameraMoveAxis, checkFraming, checkRigClearance, editorShotState, findSlide} from "./path.js?v=spatial-plan";
import {actorCenter, checkCameraHeight, maxActors} from "./room-state.js?v=spatial-plan";

const MOVES = new Set(["slide", "push", "pull", "static"]);

function finitePair(value) {
  return Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(Number.isFinite)
    ? [value[0], value[1]] : null;
}

function framingActors(value) {
  if (!Array.isArray(value) || value.length > maxActors) return null;
  const actors = value.filter(point => point != null).map(finitePair);
  return actors.length >= 2 && actors.every(Boolean) ? actors : null;
}

function bounded(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function moveLabel(moveKind, travel) {
  if (!travel) return "Static shot";
  const name = {push: "push-in", pull: "pull-back", slide: "slide"}[moveKind] || moveKind;
  return travel.toFixed(2) + " m " + name;
}

function evidenceSentence(obstacles, sightlineChecks, ceiling) {
  return (obstacles.length ? ", checked against " + obstacles.length + " marked furniture footprints." : ".") +
    (sightlineChecks ? " Clear at five sampled eye-level scan positions." : " Captured sightlines unverified.") +
    (ceiling.status === "unknown" ? " Room height unverified." : "");
}

function result(status, fields) {
  return {status, missedConstraint: fields.missedConstraint ?? null, label: fields.label,
    reason: fields.reason, setup: fields.setup ?? null, measurements: fields.measurements ?? null,
    evaluation: fields.evaluation ?? null, ceiling: fields.ceiling ?? null,
    missing: fields.missing ?? null};
}

// Search camera placements for a locked shot. Travel may shorten. A setup that
// clears the room but misses minimum travel is a labeled fallback.
export function solveShot(room, constraints = {}) {
  const move = constraints.move ?? constraints.moveKind ?? "slide";
  const lens = constraints.lens;
  const sensorWidthMm = constraints.sensorWidthMm ?? constraints.sensorWidth;
  const cameraHeight = constraints.cameraHeight;
  const rigRadius = constraints.rigRadius;
  const targetTravel = move === "static" ? 0 : constraints.targetTravel;
  const minimumTravel = constraints.minimumTravel ?? 0;
  if (!MOVES.has(move))
    return result("fail", {label: "Fails move", reason: "Unsupported camera move."});
  if (!bounded(lens, 15, 150))
    return result("fail", {label: "Fails lens", reason: "Lens must be between 15 and 150 mm."});
  if (!bounded(sensorWidthMm, 8, 65))
    return result("fail", {label: "Fails sensorWidth", reason: "Sensor width must be between 8 and 65 mm."});
  if (!bounded(cameraHeight, .15, 4))
    return result("fail", {label: "Fails cameraHeight", reason: "Camera height must be between 0.15 and 4 m."});
  if (!bounded(rigRadius, .05, 1.5))
    return result("fail", {label: "Fails rigRadius", reason: "Rig radius must be between 0.05 and 1.5 m."});
  if (!bounded(targetTravel, 0, 4) || !bounded(minimumTravel, 0, 4))
    return result("fail", {label: "Fails travel", reason: "Travel must be between 0 and 4 m."});
  if (minimumTravel > targetTravel + 1e-8)
    return result("fail", {label: "Fails minimumTravel",
      reason: "Minimum travel must be at or below the target travel.",
      missedConstraint: "minimumTravel"});

  const outline = room?.outline;
  if (!Array.isArray(outline) || outline.length < 3 || outline.some(point => !finitePair(point)))
    return result("missing-evidence", {label: "Missing evidence: room outline",
      reason: "Room outline is missing.", missing: ["room outline"]});

  const actors = framingActors(constraints.actors ?? room.actors);
  const mark = finitePair(constraints.mark ?? room.camera);
  if (!actors || !mark)
    return result("missing-evidence", {label: "Missing evidence: actor marks",
      reason: "Two actor marks and a camera mark are needed.",
      missing: [...(actors ? [] : ["actors"]), ...(mark ? [] : ["camera"])]});

  const aim = finitePair(constraints.aim) || finitePair(room.lookAt) ||
    actorCenter(actors);
  const aimHeight = bounded(constraints.aimHeight, 0, 100) ? constraints.aimHeight
    : bounded(room.aimHeight, 0, 100) ? room.aimHeight : 1.22;
  const ceiling = checkCameraHeight(room, cameraHeight);
  if (ceiling.status === "fail")
    return result("fail", {label: "Fails cameraHeight", ceiling,
      reason: "Camera height reaches or exceeds the reported room height.",
      missedConstraint: "cameraHeight"});

  if (constraints.requireSightlines && room.matterpakAlignmentVerified !== true)
    return result("missing-evidence", {label: "Missing evidence: captured sightlines",
      reason: "Captured sightlines unknown: " + (constraints.sightlineStatus || "alignment unverified") + ".",
      missing: ["captured sightlines"], ceiling});
  if (constraints.requireSightlines && typeof constraints.sightlineCheck !== "function")
    return result("missing-evidence", {label: "Missing evidence: captured sightlines",
      reason: "Captured sightlines unknown: " + (constraints.sightlineStatus || "mesh unavailable") + ".",
      missing: ["captured sightlines"], ceiling});

  const obstacles = Array.isArray(constraints.obstacles) ? constraints.obstacles : [];
  const keepMark = constraints.keepMark === true;
  const axis = cameraMoveAxis(move, mark, aim, constraints.slideAxis ?? room.slideAxis);
  const optical = {focal: lens, width: sensorWidthMm, aspect: 16 / 9, cameraHeight, aimHeight};
  const sightline = constraints.requireSightlines ? constraints.sightlineCheck : null;
  const sightlineLimit = constraints.sightlineLimit ?? 8;
  const rejections = {clearance: 0, framing: 0, sightline: 0};
  let passedClearance = 0;
  let sightlineChecks = 0;
  let limited = false;
  const found = findSlide(outline, mark, aim, axis, targetTravel, rigRadius, keepMark, obstacles, (from, to) => {
    passedClearance++;
    if (checkFraming(from, to, aim, actors, optical).margin < 0) {
      rejections.framing++;
      return false;
    }
    if (!sightline) return true;
    if (sightlineChecks >= sightlineLimit) {
      limited = true;
      return false;
    }
    sightlineChecks++;
    if (!sightline(from, to)) return true;
    rejections.sightline++;
    return false;
  });
  rejections.clearance = found.checked - passedClearance;
  const evaluation = {tested: found.checked, clearanceRejected: rejections.clearance,
    framingRejected: rejections.framing, sightlineRejected: rejections.sightline,
    sightlineChecks, sightlineLimitReached: limited};

  if (!found.mark) {
    return result("fail", {label: limited ? "Fails captured sightlines" : "Fails placement",
      reason: limited ? "Captured sightline search reached its eight-candidate limit."
        : "No setup passed. Tested " + evaluation.tested + " setups; " +
          evaluation.clearanceRejected + " failed rig clearance, " +
          evaluation.framingRejected + " failed framing and " +
          evaluation.sightlineRejected + " hit a captured obstruction.",
      evaluation, ceiling});
  }

  const direction = axis && Math.hypot(...axis) >= 1e-8 ? axis
    : [aim[1] - found.mark[1], found.mark[0] - aim[0]];
  const setup = {
    mark: found.mark.slice(), axis: direction.slice(), travel: found.length, moveKind: move,
    lens, sensorWidthMm, cameraHeight, rigRadius, aimHeight, aim: aim.slice(),
    aimLocked: constraints.aimLocked === true, actors: actors.map(actor => actor.slice()),
    obstacles, keepMark, requireSightlines: sightlineChecks > 0,
    durationSeconds: constraints.durationSeconds,
  };
  const pose = editorShotState(setup);
  setup.start = pose.start;
  setup.end = pose.end;
  const framing = checkFraming(pose.start, pose.end, aim, actors, optical);
  const clearance = checkRigClearance(outline, obstacles, pose.start, pose.end, rigRadius);
  const measurements = {travel: found.length, start: pose.start, end: pose.end,
    clearanceMargin: clearance.margin, framingMargin: framing.margin,
    limitingFeature: clearance.feature, ceiling, lens, aim: setup.aim, actors: setup.actors};
  const sentence = evidenceSentence(obstacles, sightlineChecks, ceiling);
  if (found.length + 1e-8 < minimumTravel) {
    return result("fallback", {label: "Fallback misses minimumTravel",
      missedConstraint: "minimumTravel", evaluation, ceiling, setup, measurements,
      reason: "Fallback misses minimumTravel: " + moveLabel(move, found.length) +
        " passes wall clearance and sampled framing, below the " +
        minimumTravel.toFixed(2) + " m minimum" + sentence});
  }
  return result("pass", {label: "Passes", evaluation, ceiling, setup, measurements,
    reason: moveLabel(move, found.length) + " with wall clearance and sampled framing" + sentence});
}
