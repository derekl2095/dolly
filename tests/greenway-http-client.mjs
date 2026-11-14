import assert from "node:assert/strict";
import {runAgent} from "../site/agent.js";

const base = process.argv[2];
let alternatives;
let evidence;
await runAgent("Find the Greenway showroom in Houston for a 35 mm lateral slide.", {
  lockedLens: 35,
  lockedMove: "slide",
  minimumTravel: .7,
  allowApply: false,
  activity() {},
  onEvidence(value) { evidence = value; },
  onAlternatives(value) { alternatives = value; },
  apply() { assert.fail("Report-only must not apply a proposal"); },
  async api(path, options) {
    const response = await fetch(base + path, options);
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  },
});
assert.equal(alternatives.length, 1);
const [{room, setup}] = alternatives;
assert.equal(room.modelId, "39kv7R6xV7o");
assert.equal(setup.lens, 35);
assert.ok(Math.abs(setup.travel - .7) < 1e-9);
assert.equal(evidence.recommended, alternatives[0].id);
assert.ok(evidence.candidates[0].framingMargin > 0);
assert.equal(evidence.candidates[0].sightlinesSampled, false);
console.log("Verified the provider relay, CoStar catalog, Greenway geometry and report-only shot handoff.");
