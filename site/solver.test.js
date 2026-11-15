import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import test from "node:test";
import {editorShotState, readShotExport, roundStroke, slideEndpoints, tracePath} from "./path.js";
import {solveShot} from "./solver.js";
import {compareRooms} from "./compare.js";
import {planProjection} from "./plan-projection.js";
import {capturedSpaceLabel, cleanPropertyDescription, listedArea, spaceLabel} from "./location-labels.js";

test("catalog labels use room names and omit tour marketing", () => {
  assert.equal(spaceLabel("Checkout Out Our Model!"), "");
  assert.equal(spaceLabel("Matterport Virtual Tour – Showroom"), "Showroom");
  assert.equal(spaceLabel("3D Tour of Training Room"), "Training Room");
  assert.equal(spaceLabel("Training Room (3D)"), "Training Room");
  assert.equal(spaceLabel("3D - Suite West"), "Suite West");
  assert.equal(cleanPropertyDescription("[Canal] [Street] Flats", "Canal Street Flats"), "");
  assert.equal(cleanPropertyDescription("Near [Canal] Street."), "Near Canal Street.");
  assert.equal(spaceLabel("2BR, 2BA - 1015 SqFt (B3)"), "2BR, 2BA (B3)");
  assert.equal(spaceLabel("2BR,2BA_1,124 Sq Ft"), "2BR,2BA");
  assert.equal(listedArea("2BR, 2BA - 1015 SqFt (B3)"), "1,015 sq ft");
  assert.equal(capturedSpaceLabel(["Closet", "Bedroom", "Bedroom", "Dining Room"]
    .map(label => ({label}))), "Bedroom / Dining Room");
});

test("rotated room projection preserves floor and elevated drag coordinates", () => {
  const view = planProjection({center: [4, 3], origin: [320, 200], scale: 44,
    bearing: -.7, elevation: Math.PI / 3});
  const point = [7, 1.5];
  for (const height of [0, 1.42, 2.5]) {
    const world = view.unproject(view.project(point, height), height);
    assert.ok(Math.hypot(world[0] - point[0], world[1] - point[1]) < 1e-10);
  }
  assert.ok(view.project(point, 2.5)[1] < view.project(point)[1]);
});

const shot = {
  lens: 35, sensorWidthMm: 36, cameraHeight: 1.42, rigRadius: .25,
  move: "slide", targetTravel: .7, minimumTravel: .4,
};

test("a drawn curve plays by distance and survives a shot export", () => {
  const pathPoints = roundStroke([[0, 0], [0, 1], [2, 1]]);
  const curve = tracePath(pathPoints);
  assert.deepEqual(curve.at(0), [0, 0]);
  assert.deepEqual(curve.at(1), [2, 1]);
  assert.ok(curve.at(.5)[1] > .9);
  const payload = {schemaVersion: 1, units: "meters", interpolation: "smoothstep",
    modelId: "fixture", moveKind: "curve", start: curve.at(0), end: curve.at(1),
    pathPoints, aim: [1, 2], actors: [[1, 1], [1.5, 1], [2, 1]], focalLengthMm: 35,
    cameraHeight: 1.42, sensorWidthMm: 36, rigRadius: .25, durationSeconds: 3.8,
    aspect: [16, 9], obstacles: [{name: "Chair", min: [1, 2], max: [2, 3], height: .85}]};
  const {setup} = readShotExport(JSON.stringify(payload));
  assert.deepEqual(setup.pathPoints, pathPoints);
  assert.deepEqual(setup.actors, payload.actors);
  assert.deepEqual(setup.obstacles, payload.obstacles);
  assert.equal(setup.travel, curve.travel);
  assert.throws(() => readShotExport(JSON.stringify({...payload, end: [1, 1]})), /curve is invalid/);
  assert.equal(tracePath([[0, 0], [0, 3], [1, 0]]), null);
});

function rectangle({width = 8, depth = 6, height = 3, camera, actors, slideAxis = [1, 0], aim} = {}) {
  const actorZ = depth * .22;
  return {modelId: "fixture", units: "meters", height, heightEstimated: false, slideAxis, aim,
    outline: [[0, 0], [width, 0], [width, depth], [0, depth]],
    camera: camera || [width / 2, Math.min(depth - .8, actorZ + 4.2)],
    actors: actors || [[width / 2 - .45, actorZ], [width / 2 + .45, actorZ]]};
}

function loadGreenway() {
  const roomPath = new URL("../local-assets/room.json", import.meta.url);
  const meshPath = new URL("../mesh-cache/39kv7R6xV7o/manifest.json", import.meta.url);
  assert.ok(existsSync(roomPath), "Extract scout-preview-data.tar.gz beside app.py before running solver tests.");
  assert.ok(existsSync(meshPath), "Greenway MatterPak manifest is missing from mesh-cache/39kv7R6xV7o.");
  const room = JSON.parse(readFileSync(roomPath, "utf8"));
  const preset = JSON.parse(readFileSync(new URL("../presets/39kv7R6xV7o.json", import.meta.url), "utf8"));
  assert.equal(room.modelId, "39kv7R6xV7o");
  return {...room, ...preset};
}

function assertEditorPose(solved, constraints) {
  const pose = editorShotState(solved.setup);
  const [start, end] = slideEndpoints(solved.setup.mark, solved.setup.axis, solved.setup.travel);
  assert.deepEqual(pose.start, start);
  assert.deepEqual(pose.end, end);
  assert.deepEqual(pose.start, solved.measurements.start);
  assert.deepEqual(pose.end, solved.measurements.end);
  assert.deepEqual(solved.setup.start, solved.measurements.start);
  assert.deepEqual(solved.setup.end, solved.measurements.end);
  assert.equal(pose.lens, constraints.lens);
  assert.deepEqual(pose.aim, solved.setup.aim);
  assert.deepEqual(pose.actors, solved.setup.actors);
  assert.equal(solved.setup.sensorWidthMm, constraints.sensorWidthMm);
  assert.equal(solved.setup.cameraHeight, constraints.cameraHeight);
  assert.equal(solved.setup.rigRadius, constraints.rigRadius);
  assert.equal(solved.setup.moveKind, constraints.move);
}

test("small room passes and the editor pose matches the evaluated shot", () => {
  const room = rectangle();
  const solved = solveShot(room, shot);
  assert.equal(solved.status, "pass");
  assert.equal(solved.missedConstraint, null);
  assert.ok(Math.abs(solved.setup.travel - .7) < 1e-9);
  assert.ok(solved.measurements.clearanceMargin >= 0);
  assert.ok(solved.measurements.framingMargin >= 0);
  assert.equal(solved.measurements.ceiling.status, "pass");
  assertEditorPose(solved, shot);
  const compared = compareRooms([room], shot.lens, shot.targetTravel, shot.move, new Map(), {
    sensorWidthMm: shot.sensorWidthMm, cameraHeight: shot.cameraHeight, rigRadius: shot.rigRadius,
    minimumTravel: shot.minimumTravel,
  });
  assert.equal(compared[0].status, "pass");
  assert.equal(compared[0].length, solved.setup.travel);
  assert.deepEqual(compared[0].setup.start, solved.setup.start);
  assert.deepEqual(compared[0].setup.actors, solved.setup.actors);
});

test("alternative placements keep locked lens, actors, and aim", () => {
  const room = rectangle({width: 10, depth: 10, camera: [5, 8],
    actors: [[4.6, 2], [5.4, 2]], aim: [5, 2]});
  const [cx, cz] = room.camera;
  const solved = solveShot(room, {...shot, keepMark: false, obstacles: [
    {name: "table", min: [cx - .4, cz - .4], max: [cx + .4, cz + .4]}]});
  assert.equal(solved.status, "pass");
  assert.ok(Math.hypot(solved.setup.mark[0] - cx, solved.setup.mark[1] - cz) > .1);
  assert.deepEqual(solved.setup.aim, [5, 2]);
  assert.deepEqual(solved.setup.actors, room.actors);
  assertEditorPose(solved, shot);
  const locked = solveShot(room, {...shot, keepMark: true, obstacles: [
    {name: "table", min: [cx - .4, cz - .4], max: [cx + .4, cz + .4]}]});
  assert.equal(locked.status, "fail");
  assert.equal(locked.setup, null);
  assert.match(locked.reason, /failed rig clearance/);
});

test("a short clear move is a fallback that names minimumTravel", () => {
  const room = rectangle({width: 8, depth: 1.3, slideAxis: [0, 1], camera: [2, .65],
    actors: [[6.2, .45], [6.8, .85]], aim: [6.5, .65]});
  const constraints = {...shot, cameraHeight: 1.2, targetTravel: 2, minimumTravel: 1.2};
  const solved = solveShot(room, constraints);
  assert.equal(solved.status, "fallback");
  assert.equal(solved.missedConstraint, "minimumTravel");
  assert.equal(solved.label, "Fallback misses minimumTravel");
  assert.ok(solved.setup.travel < constraints.minimumTravel);
  assert.ok(solved.measurements.clearanceMargin >= 0);
  assert.ok(solved.measurements.framingMargin >= 0);
  assertEditorPose(solved, constraints);
});

test("a rig that cannot clear the walls fails", () => {
  const room = rectangle({width: .4, depth: .4, camera: [.2, .3],
    actors: [[.12, .1], [.28, .1]]});
  const solved = solveShot(room, shot);
  assert.equal(solved.status, "fail");
  assert.equal(solved.setup, null);
  assert.ok(solved.evaluation.clearanceRejected > 0);
  const ceiling = solveShot(rectangle({height: 2}), {...shot, cameraHeight: 2});
  assert.equal(ceiling.status, "fail");
  assert.equal(ceiling.missedConstraint, "cameraHeight");
  assert.match(ceiling.reason, /room height/);
});

test("missing actors or unverified sightlines are missing evidence", () => {
  const room = rectangle();
  const missingActors = solveShot({...room, actors: [room.actors[0], null]}, shot);
  assert.equal(missingActors.status, "missing-evidence");
  assert.deepEqual(missingActors.missing, ["actors"]);
  assert.equal(missingActors.setup, null);
  assert.match(missingActors.reason, /Two actor marks/);
  const sightlines = solveShot(room, {...shot, requireSightlines: true, sightlineStatus: "alignment unverified"});
  assert.equal(sightlines.status, "missing-evidence");
  assert.deepEqual(sightlines.missing, ["captured sightlines"]);
  assert.match(sightlines.reason, /alignment unverified/);
  const verified = solveShot({...room, matterpakAlignmentVerified: true}, {...shot, requireSightlines: true});
  assert.equal(verified.status, "missing-evidence");
  assert.match(verified.reason, /mesh unavailable/);
});

test("Greenway scan passes a 0.70 m slide and reports a short fallback", () => {
  const room = loadGreenway();
  assert.equal(room.matterpakAlignmentVerified, true);
  assert.equal(room.label, "Twelve Greenway Plaza");
  const constraints = {...shot, cameraHeight: room.cameraHeight, aimHeight: room.aimHeight};
  const solved = solveShot(room, constraints);
  assert.equal(solved.status, "pass");
  assert.ok(Math.abs(solved.setup.travel - .7) < 1e-9);
  assert.equal(solved.measurements.ceiling.status, "unknown");
  assertEditorPose(solved, constraints);
  const fallback = solveShot(room, {...constraints, targetTravel: 4, minimumTravel: 3.5});
  assert.equal(fallback.status, "fallback");
  assert.equal(fallback.missedConstraint, "minimumTravel");
  assert.ok(fallback.setup.travel < 3.5);
  assertEditorPose(fallback, {...constraints, targetTravel: 4, minimumTravel: 3.5});
  const blocked = solveShot(room, {...constraints, rigRadius: 1.5});
  assert.equal(blocked.status, "fail");
  assert.equal(blocked.setup, null);
});

test("the editor applies solved aim, actors, and endpoint pose", () => {
  const source = readFileSync(new URL("./mesh.js", import.meta.url), "utf8");
  assert.match(source, /editorShotState\(/);
  assert.match(source, /setup\.aim/);
  assert.match(source, /setup\.actors/);
  assert.match(source, /pose\.lens/);
  assert.match(source, /pose\.travel/);
});
