import assert from "node:assert/strict";
import test from "node:test";
import {relightLevels, representativeShade, surfaceGroup} from "../site/relight.js";

test("photo highlights and deep shadows do not become the room's base shade", () => {
  const carpet = [123, 88, 93];
  const samples = [...Array(12).fill(carpet), [253, 229, 164], [19, 18, 23]];
  assert.deepEqual(representativeShade(samples), carpet.map(channel => channel / 255));
  assert.equal(representativeShade([carpet]), null);
  assert.notEqual(surfaceGroup(.03, 1), surfaceGroup(.62, 1));
  assert.notEqual(surfaceGroup(.62, 1), surfaceGroup(.62, 0));
});

test("relit shade stays readable during the day and dims after sunset", () => {
  assert.ok(relightLevels(35).sky > relightLevels(-12).sky * 10);
  assert.ok(relightLevels(35).beam > relightLevels(7).beam);
  assert.equal(relightLevels(-1).beam, 0);
});


test("batch staging preserves saved windows and avoids duplicate panes", async () => {
  const {stageWindowCandidates} = await import("../site/daylight.js");
  const pane = {corners: [[0, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]], outward: [0, 0, 1], source: "Scan"};
  const next = {...pane, corners: pane.corners.map(([x, y, z]) => [x + 2, y, z])};
  const existing = [{...pane, id: "window-1"}];
  const staged = stageWindowCandidates(existing, [{...pane, corners: [...pane.corners].reverse()}, next, next]);
  assert.equal(existing.length, 1);
  assert.deepEqual(staged.map(window => window.id), ["window-1", "window-2"]);
  const full = Array.from({length: 32}, (_, i) => ({...pane, id: "saved-" + i}));
  assert.throws(() => stageWindowCandidates(full, [next]), /up to 32/);
  assert.equal(full.length, 32);
});

test("Gemini wall boxes project into room coordinates with image-Y inversion and wall winding", async () => {
  const {windowFromWallImage} = await import("../site/daylight.js");
  const wall = {origin: [5, 0, 2], axis: [0, 0, 1], outward: [1, 0, 0],
    width: 6, frameWidth: 8, frameHeight: 4, y0: -.5, elevation: 3, pad: 1, size: 160};
  const box = [250, 250, 500, 500];
  assert.deepEqual(windowFromWallImage(wall, box).corners,
    [[5, 1.5, 3], [5, 1.5, 5], [5, 2.5, 5], [5, 2.5, 3]]);
  assert.deepEqual(windowFromWallImage({...wall, reversed: true}, box).corners,
    [[5, 1.5, 5], [5, 1.5, 7], [5, 2.5, 7], [5, 2.5, 5]]);
  assert.equal(windowFromWallImage(wall, [250, -1, 500, 500]), null);
  assert.equal(windowFromWallImage(wall, [500, 250, 250, 500]), null);
});
