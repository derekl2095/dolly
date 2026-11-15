import {maxActors} from "./room-state.js?v=spatial-plan";

export function easedPathFraction(timeFraction) {
  return timeFraction * timeFraction * (3 - 2 * timeFraction);
}

export function timeFractionAtPath(pathFraction) {
  if (pathFraction <= 0) return 0;
  if (pathFraction >= 1) return 1;
  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 20; i++) {
    const midpoint = (lower + upper) / 2;
    if (easedPathFraction(midpoint) < pathFraction) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

export function cameraMoveAxis(kind, center, aim, slideAxis) {
  if (kind === "push") return aim.map((value, index) => value - center[index]);
  if (kind === "pull") return center.map((value, index) => value - aim[index]);
  return slideAxis;
}

function distanceToEdge(point, start, end) {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const squared = dx * dx + dz * dz;
  const t = squared ? Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / squared)) : 0;
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dz);
}

function signedWallDistance(outline, point) {
  let inside = false;
  let distance = Infinity;
  const [px, pz] = point;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    distance = Math.min(distance, distanceToEdge(point, a, b));
    if ((a[1] > pz) !== (b[1] > pz) &&
        px < a[0] + (pz - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
  }
  return inside ? distance : -distance;
}

export function checkWallClearance(outline, start, end, radius) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const steps = Math.max(1, Math.ceil(length / .025));
  let margin = Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    margin = Math.min(margin, signedWallDistance(outline, [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ]));
  }
  // Distance to a boundary changes by at most the distance traveled.
  return margin - length / steps / 2 - radius;
}

export function slideEndpoints(center, axis, distance) {
  const norm = Math.hypot(...axis);
  if (norm < 1e-8) return [center, center];
  const offset = axis.map(component => component / norm * distance / 2);
  return [center.map((coordinate, i) => coordinate - offset[i]),
    center.map((coordinate, i) => coordinate + offset[i])];
}

// The editor and the solver both read a setup through this pose, so scrubbing
// a solved shot reproduces the evaluated endpoints.
export function editorShotState(setup) {
  const moveKind = setup.moveKind || "slide";
  const travel = moveKind === "static" ? 0 : Number(setup.travel) || 0;
  const mark = setup.mark;
  const aim = setup.aim;
  let axis = setup.axis;
  if (!axis || Math.hypot(...axis) < 1e-8) {
    axis = cameraMoveAxis(moveKind, mark, aim, setup.slideAxis);
  }
  if (!axis || Math.hypot(...axis) < 1e-8) {
    axis = aim ? [aim[1] - mark[1], mark[0] - aim[0]] : [1, 0];
  }
  const [start, end] = slideEndpoints(mark, axis, travel);
  return {
    start, end, axis, travel, moveKind,
    lens: setup.lens,
    mark: mark.slice(),
    aim: aim ? aim.slice() : null,
    actors: Array.isArray(setup.actors) ? setup.actors.map(actor => actor ? actor.slice() : null) : null,
    sensorWidthMm: setup.sensorWidthMm,
    cameraHeight: setup.cameraHeight,
    rigRadius: setup.rigRadius,
  };
}

export function pathFromEndpoints(start, end) {
  const axis = end.map((value, index) => value - start[index]);
  return {
    mark: start.map((value, index) => (value + end[index]) / 2),
    axis,
    travel: Math.hypot(...axis),
  };
}

export const maxCurvePoints = 512;

export function tracePath(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > maxCurvePoints ||
      !points.every(point => Array.isArray(point) && point.length === 2 &&
        point.every(value => Number.isFinite(value) && Math.abs(value) <= 100000))) return null;
  let travel = 0;
  const segments = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length === 0) continue;
    segments.push({from, to, length, start: travel});
    travel += length;
  }
  if (travel < .01 || travel > 4 + 1e-8) return null;
  return {
    points, segments, travel,
    at(fraction) {
      const distance = Math.max(0, Math.min(1, fraction)) * travel;
      const segment = segments.find(item => distance <= item.start + item.length) ?? segments.at(-1);
      const t = (distance - segment.start) / segment.length;
      return segment.from.map((value, axis) => value + (segment.to[axis] - value) * t);
    },
  };
}

export function roundStroke(points) {
  if (points.length < 3) return points;
  const rounded = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index];
    for (const weight of [.25, .75]) rounded.push(from.map((value, axis) => value + weight * (to[axis] - value)));
  }
  rounded.push(points.at(-1));
  return rounded;
}

// Search nearby marks with the same aim and lens before reducing travel.
export function findSlide(outline, center, aim, axis, distance, radius, keepMark, obstacles = [], accepts = () => true) {
  const steps = Math.floor(distance / .05 + 1e-7);
  let checked = 0;
  const offsets = [[0, 0]];
  if (!keepMark) {
    for (let shift = .15; shift <= .91; shift += .15) {
      for (let index = 0; index < 8; index++) {
        const angle = index * Math.PI / 4;
        offsets.push([shift * Math.cos(angle), shift * Math.sin(angle)]);
      }
    }
  }
  for (let step = steps; step >= 0; step--) {
    const length = step / 20;
    for (const [dx, dz] of offsets) {
      const mark = [center[0] + dx, center[1] + dz];
      const direction = axis || [aim[1] - mark[1], mark[0] - aim[0]];
      if (Math.hypot(...direction) < 1e-8) continue;
      const [start, end] = slideEndpoints(mark, direction, length);
      const {margin} = checkRigClearance(outline, obstacles, start, end, radius);
      checked++;
      if (margin >= 0 && accepts(start, end)) return {mark, length, margin, checked};
    }
  }
  return {checked};
}

export function checkRigClearance(outline, obstacles, start, end, radius) {
  const wallMargin = checkWallClearance(outline, start, end, radius);
  let result = {margin: wallMargin, feature: "room wall"};
  for (const obstacle of obstacles) {
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = Math.max(1, Math.ceil(length / .025));
    let margin = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = start[0] + (end[0] - start[0]) * t;
      const z = start[1] + (end[1] - start[1]) * t;
      const dx = Math.max(obstacle.min[0] - x, 0, x - obstacle.max[0]);
      const dz = Math.max(obstacle.min[1] - z, 0, z - obstacle.max[1]);
      margin = Math.min(margin, Math.hypot(dx, dz));
    }
    margin -= length / steps / 2 + radius;
    if (margin < result.margin) result = {margin, feature: obstacle.name};
  }
  return result;
}

// Project the corners of a conservative stand-in box into the camera frame.
export function checkFraming(start, end, aim, actors, settings) {
  const {focal, width, aspect, cameraHeight, aimHeight} = settings;
  const horizontal = width / (2 * focal);
  const vertical = horizontal / aspect;
  let margin = Infinity, limitingProgress = 0;
  const steps = Math.max(20, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / .025));
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const x = start[0] + (end[0] - start[0]) * t;
    const z = start[1] + (end[1] - start[1]) * t;
    const dx = aim[0] - x, dz = aim[1] - z, dy = aimHeight - cameraHeight;
    const run = Math.hypot(dx, dz), length = Math.hypot(run, dy);
    if (run < 1e-8) return {margin: -Infinity, limitingProgress: t};
    const fx = dx / length, fy = dy / length, fz = dz / length;
    const rx = -dz / run, rz = dx / run;
    const ux = -rz * fy, uy = run / length, uz = rx * fy;
    for (const [ax, az] of actors) {
      for (const i of [-.17, .17]) for (const j of [-.17, .17]) {
        for (const height of [.25, 1.61]) {
          const px = ax + i - x, pz = az + j - z, py = height - cameraHeight;
          const depth = px * fx + py * fy + pz * fz;
          const remaining = depth <= .03 ? -Infinity : 1 - Math.max(
            Math.abs(px * rx + pz * rz) / (depth * horizontal),
            Math.abs(px * ux + py * uy + pz * uz) / (depth * vertical));
          if (remaining < margin) {
            margin = remaining;
            limitingProgress = t;
          }
        }
      }
    }
  }
  return {margin, limitingProgress};
}

export function interpretDirection(note, currentDistance) {
  const text = note.toLowerCase().trim();
  if (/\b(?:tighter|wider|closer|zoom|lighting|sunset|pan|tilt|push.in|remove|ignore|override)\b/.test(text)) return null;
  const amount = text.match(/\b(\d+(?:\.\d+)?)\s*(?:meters?|metres?|m)\b/);
  const shorter = /\bshorter\b/.test(text);
  const longer = /\blonger\b/.test(text);
  if (!amount && shorter === longer) return null;
  if (shorter && longer) return null;
  const distance = amount ? Number(amount[1]) : currentDistance + (longer ? .3 : -.3);
  return {distance: Math.round(Math.max(0, Math.min(4, distance)) * 20) / 20};
}

export function readShotExport(text) {
  const shot = JSON.parse(text);
  const point = value => Array.isArray(value) && value.length === 2 &&
    value.every(coordinate => Number.isFinite(coordinate) && Math.abs(coordinate) <= 100000);
  const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  if (!shot || shot.schemaVersion !== 1 || shot.units !== "meters" ||
      shot.interpolation !== "smoothstep" ||
      typeof shot.modelId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(shot.modelId) ||
      (shot.roomId != null && (typeof shot.roomId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(shot.roomId))) ||
      ![shot.start, shot.end, shot.aim].every(point) ||
      !Array.isArray(shot.actors) || shot.actors.length < 2 || shot.actors.length > maxActors ||
      !shot.actors.every(actor => actor === null || point(actor)) ||
      (shot.aimHeight != null && !bounded(shot.aimHeight, 0, 100)) ||
      !bounded(shot.cameraHeight, .15, 4) || !bounded(shot.sensorWidthMm, 8, 65) ||
      !bounded(shot.rigRadius, .05, 1.5) || !bounded(shot.durationSeconds, .5, 30) ||
      !bounded(shot.focalLengthMm, 15, 150) ||
      !Array.isArray(shot.aspect) || shot.aspect.length !== 2 || shot.aspect[0] !== 16 || shot.aspect[1] !== 9 ||
      !Array.isArray(shot.obstacles) || !shot.obstacles.every(item =>
        item && typeof item.name === "string" && point(item.min) && point(item.max) &&
        (item.height == null || bounded(item.height, 0, 12)) &&
        item.min.every((value, index) => value < item.max[index]))) {
    throw Error("This file is not a supported shot export.");
  }
  const curve = shot.pathPoints == null ? null : tracePath(shot.pathPoints);
  if ((shot.pathPoints != null || shot.moveKind === "curve") &&
      (!curve || shot.moveKind !== "curve" ||
       !shot.start.every((value, axis) => value === curve.points[0][axis]) ||
       !shot.end.every((value, axis) => value === curve.points.at(-1)[axis]))) {
    throw Error("The exported curve is invalid or exceeds 4 m.");
  }
  const path = curve
    ? {pathPoints: curve.points, mark: curve.at(.5), travel: curve.travel}
    : pathFromEndpoints(shot.start, shot.end);
  if (path.travel > 4 + 1e-8) throw Error("The exported move is longer than 4 m.");
  const moveKind = curve ? "curve" : path.travel < 1e-8 ? "static"
    : ["slide", "push", "pull"].includes(shot.moveKind) ? shot.moveKind : "custom";
  return {modelId: shot.modelId, roomId: shot.roomId, setup: {
    ...path, travel: moveKind === "static" ? 0 : Math.min(path.travel, 4),
    moveKind, aim: shot.aim, aimHeight: shot.aimHeight, aimLocked: shot.aimLocked !== false, actors: shot.actors,
    obstacles: shot.obstacles, lens: shot.focalLengthMm, cameraHeight: shot.cameraHeight,
    sensorWidthMm: shot.sensorWidthMm, rigRadius: shot.rigRadius, durationSeconds: shot.durationSeconds,
    keepMark: shot.keepMark !== false, requireSightlines: shot.requireSightlines === true,
  }};
}
