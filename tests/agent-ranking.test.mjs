import assert from "node:assert/strict";
import test from "node:test";
import {runAgent} from "../site/agent.js";

test("agent ranks qualifying results and rejects a below-minimum shot", async () => {
  let evidence;
  let opened;
  const call = (name, args) => ({
    id: name, function: {name, arguments: JSON.stringify(args)},
  });
  const revise = distance => call("revise_current_shot", {
    slide: distance, lens: null, cameraHeight: null, objective: "travel",
  });
  const turns = [
    {tool_calls: [revise(1), revise(2), revise(.25)]},
    {tool_calls: [call("apply_shot", {candidate: "shot-3"})]},
    {tool_calls: [call("apply_shot", {candidate: "shot-2"})]},
    {content: "Checked the shot."},
  ];
  await runAgent("Test a move", {
    lockedLens: 35,
    current: {lens: 35, travel: 1},
    minimumTravel: .5,
    allowApply: true,
    activity() {},
    onEvidence(value) { evidence = value; },
    revise({distance}) {
      const travel = distance === 1 ? .75 : distance;
      return {setup: {travel}, clearanceMargin: .2, reason: "Sampled setup"};
    },
    apply(_room, setup) { opened = setup; },
    async api() { return turns.shift(); },
  });
  assert.equal(evidence.recommended, "shot-2");
  assert.equal(evidence.queued, "shot-2");
  assert.equal(evidence.candidates.at(-1).status, "fallback");
  assert.deepEqual(evidence.candidates.at(-1).unmet, ["Minimum travel"]);
  assert.equal(opened.travel, 2);
});
