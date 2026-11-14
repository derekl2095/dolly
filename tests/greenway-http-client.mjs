import assert from "node:assert/strict";
import {runAgent} from "../site/agent.js";

const base = process.argv[2];
async function api(path, options) {
  const response = await fetch(base + path, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

async function scout(minimumTravel, allowApply) {
  let alternatives;
  let evidence;
  await runAgent("Find the Greenway showroom in Houston for a 35 mm lateral slide.", {
    lockedLens: 35,
    lockedMove: "slide",
    minimumTravel,
    allowApply,
    activity() {},
    onEvidence(value) { evidence = value; },
    onAlternatives(value) { alternatives = value; },
    apply() { assert.fail("This run must leave the active shot alone"); },
    api,
  });
  return {alternatives, evidence};
}

const {alternatives, evidence} = await scout(.7, false);
assert.equal(alternatives.length, 1);
const [{room, setup}] = alternatives;
assert.equal(room.modelId, "39kv7R6xV7o");
assert.equal(setup.lens, 35);
assert.ok(Math.abs(setup.travel - .7) < 1e-9);
assert.equal(evidence.recommended, alternatives[0].id);
assert.ok(evidence.candidates[0].framingMargin > 0);
assert.equal(evidence.candidates[0].sightlinesSampled, false);
console.log("Verified the provider relay, CoStar catalog, Greenway geometry and report-only shot handoff.");

const stricter = await scout(1, true);
assert.equal(stricter.evidence.recommended, undefined);
assert.equal(stricter.evidence.candidates[0].status, "fallback");
assert.deepEqual(stricter.evidence.candidates[0].unmet, ["Minimum travel"]);
assert.deepEqual(stricter.alternatives, []);
console.log("Raising the minimum travel from 0.7 m to 1 m disqualifies the evaluated Greenway shot.");

const captureBase = base + "/matterpak/" + room.modelId + "/";
const manifestResponse = await fetch(captureBase + "manifest.json");
assert.ok(manifestResponse.ok);
const manifest = await manifestResponse.json();
const mesh = await fetch(captureBase + manifest.obj.split("/").map(encodeURIComponent).join("/"));
assert.ok(mesh.ok);
const meshBytes = await mesh.arrayBuffer();
assert.ok(meshBytes.byteLength > 0);
assert.equal(room.matterpakAlignmentVerified, true);
console.log("Verified the aligned Greenway OBJ is served from the supplied preview bundle.");

const pages = [];
let paginatedEvidence;
await runAgent("Check two catalog pages of Houston office leads.", {
  catalogFilters: {city: "Houston", category: "office"},
  activity() {},
  onEvidence(value) { paginatedEvidence = value; },
  async api(path, options) {
    const data = await api(path, options);
    if (path.startsWith("/api/locations?")) pages.push(data);
    return data;
  },
});
assert.equal(pages.length, 2);
assert.equal(pages[0].next_offset, 6);
const properties = pages.flatMap(page => page.rows);
assert.equal(properties.length, 12);
assert.equal(new Set(properties.map(property => property.property_id)).size, 12);
assert.ok(properties.every(property => property.city.toLowerCase() === "houston" && property.category === "office"));
assert.equal(paginatedEvidence.coverage.propertiesFound, 12);
console.log("Verified two disjoint catalog pages with the same Houston office filters.");
