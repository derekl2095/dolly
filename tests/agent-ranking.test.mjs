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

test("agent opens a ranked candidate when authorized and the model skips selection", async () => {
  for (const [allowApply, minimumTravel, expected] of [
    [true, .5, 1], [false, .5, undefined], [true, 1.5, undefined],
  ]) {
    let opened;
    let evidence;
    const turns = [{
      tool_calls: [{
        id: "revise", function: {name: "revise_current_shot",
          arguments: JSON.stringify({slide: 1, lens: null, cameraHeight: null, objective: "travel"})},
      }],
    }, {content: "Checked the shot."}];
    await runAgent("Check a 1 m move", {
      allowApply, minimumTravel, lockedLens: 35, current: {lens: 35, travel: 1},
      activity() {}, onEvidence(value) { evidence = value; },
      revise() { return {setup: {travel: 1}, reason: "Sampled setup"}; },
      apply(_room, setup) { opened = setup.travel; },
      async api() { return turns.shift(); },
    });
    assert.equal(opened, expected);
    assert.equal(evidence.queued, expected === undefined ? undefined : "shot-1");
  }
});
