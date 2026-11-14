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
