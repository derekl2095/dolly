import assert from "node:assert/strict";
import test from "node:test";
import {briefSuggestions, runAgent} from "../site/agent.js";

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

test("a brief searches the catalog and keeps the exact checked setup available at the search limit", async () => {
  const room = {
    modelId: "Wide", roomId: "showroom", label: "Wide showroom", height: 3,
    outline: [[-3,-6],[3,-6],[3,6],[-3,6]], camera: [0,4], lookAt: [0,0],
    actors: [[-.5,0],[.5,0]], slideAxis: [1,0],
  };
  const narrow = {...room, modelId: "Narrow", outline: [[-.2,-6],[.2,-6],[.2,6],[-.2,6]]};
  const call = (name, args, id = name) => ({id, function: {name, arguments: JSON.stringify(args)}});
  const evaluate = model => call("evaluate_shot", {model, room: "showroom",
    lens: 35, slide: .7, move: "slide", requireSightlines: false}, "evaluate-" + model);
  let round = 0;
  let alternatives;
  let evidence;
  const summary = await runAgent("Houston office, 35 mm lateral slide", {
    lockedLens: 35, allowApply: false, minimumTravel: .7,
    catalogFilters: {city: "Houston", category: "office"}, activity() {},
    onEvidence(value) { evidence = value; },
    onAlternatives(value) { alternatives = value; },
    apply() { assert.fail("Report-only must not open a shot automatically"); },
    async api(path, options) {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/locations") {
        assert.equal(url.searchParams.get("city"), "Houston");
        assert.equal(url.searchParams.get("category"), "office");
        return {mode: "full", scanReadiness: {Narrow: {roomCount: 1}, Wide: {roomCount: 1}}, rows: [
          {property_id: 1, name: "Narrow", models: {Narrow: "Tour"}},
          {property_id: 2, name: "Wide", models: {Wide: "Tour"}},
          {property_id: 3, name: "No scan", models: {}},
        ]};
      }
      if (url.pathname === "/api/room")
        return url.searchParams.get("model") === "Wide" ? room : narrow;
      assert.equal(url.pathname, "/api/agent-turn");
      const last = () => JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      switch (round++) {
        case 0:
          return {tool_calls: [call("search_locations", {query: "office", city: "Los Angeles", category: null})]};
        case 1:
          return {tool_calls: [call("get_room_evidence", {model: "Narrow", room: "showroom"}), evaluate("Narrow")]};
        case 2:
          assert.equal(last().travel, null);
          assert.ok(last().evaluation.clearanceRejected > 0);
          return {tool_calls: [call("get_room_evidence", {model: "Wide", room: "showroom"}), evaluate("Wide")]};
        case 3:
          assert.ok(Math.abs(last().travel - .7) < 1e-9);
          assert.ok(last().framingMargin > 0);
          return {tool_calls: [call("compare_setups", {}, "rank-" + round)]};
        default:
          return {tool_calls: [call("compare_setups", {}, "rank-" + round)]};
      }
    },
  });
  assert.match(summary, /search limit/);
  assert.equal(alternatives.length, 1);
  const [opened] = alternatives;
  assert.equal(opened.room.modelId, "Wide");
  assert.ok(Math.abs(opened.setup.travel - .7) < 1e-9);
  assert.equal(opened.setup.lens, 35);
  assert.deepEqual(opened.setup.mark, room.camera);
  assert.deepEqual(opened.setup.axis, room.slideAxis);
  assert.deepEqual(opened.setup.aim, room.lookAt);
  assert.deepEqual(opened.setup.actors, room.actors);
  assert.deepEqual(evidence.unverifiedLeads.map(lead => lead.id), [3]);
});

test("the agent imports only an inspected scan with explicit permission", async () => {
  for (const allowImport of [false, true]) {
    let imports = 0;
    const call = (name, id) => ({id, function: {name, arguments: '{"model":"TestScan"}'}});
    const turns = [
      {tool_calls: [call("import_capture_outline", "early"), call("inspect_location", "inspect")]},
      {tool_calls: [call("import_capture_outline", "allowed"), call("import_capture_outline", "retry")]},
      {content: "Done"},
    ];
    await runAgent("Scout the shortlisted property", {
      shortlist: [{modelId: "TestScan"}], allowImport, activity() {},
      async api(path, options) {
        if (path.startsWith("/api/rooms?")) return [];
        if (path === "/api/import-room") {
          assert.deepEqual(JSON.parse(options.body), {model: "TestScan"});
          imports++;
          return {imported: 1};
        }
        const {tools} = JSON.parse(options.body);
        assert.equal(tools.some(tool => tool.function.name === "import_capture_outline"), allowImport);
        return turns.shift();
      },
    });
    assert.equal(imports, Number(allowImport));
  }
});

test("a locked pull-back cannot be substituted with a static fallback", async () => {
  let evidence;
  const turns = [
    {tool_calls: [{id: "revise", function: {name: "revise_current_shot",
      arguments: '{"slide":1,"objective":"travel"}'}}]},
    {tool_calls: [{id: "apply", function: {name: "apply_shot",
      arguments: '{"candidate":"shot-1"}'}}]},
    {content: "No qualifying pull-back."},
  ];
  await runAgent("Find a pull-back", {
    lockedMove: "pull", allowApply: true,
    current: {lens: 35, travel: 1, moveKind: "pull"},
    activity() {}, onEvidence(value) { evidence = value; },
    revise() { return {setup: {travel: 0}, reason: "Static fallback"}; },
    apply() { assert.fail("A static fallback violates the lock"); },
    async api() { return turns.shift(); },
  });
  assert.equal(evidence.recommended, undefined);
  assert.equal(evidence.queued, undefined);
  assert.deepEqual(evidence.candidates[0].unmet, ["Camera move lock"]);
});

test("shorter retries share the crew's travel target", async () => {
  let evidence;
  const turns = [
    {tool_calls: [.25, 1].map(slide => ({
      id: String(slide),
      function: {name: "revise_current_shot", arguments: JSON.stringify({slide, objective: "travel"})},
    }))},
    {content: "Compared travel."},
  ];
  await runAgent("Aim for a 1 m slide", {
    targetTravel: 1, current: {lens: 35, travel: 1},
    activity() {}, onEvidence(value) { evidence = value; },
    revise({distance}) {
      return {setup: {travel: distance === 1 ? .9 : .25}, reason: "Checked", clearanceMargin: 1 - distance};
    },
    async api() { return turns.shift(); },
  });
  assert.equal(evidence.recommended, "shot-2");
  assert.equal(evidence.candidates[1].travelDifference, .75);
});

test("a failed outline import leaves an actionable property lead", async () => {
  const call = (name, args) => ({id: name, function: {name, arguments: JSON.stringify(args)}});
  const scan = {model: "Canal"};
  let evidence;
  const turns = [
    {tool_calls: [call("search_locations", {query: "Canal"}), call("inspect_location", scan)]},
    {tool_calls: [call("import_capture_outline", scan)]},
    {content: "Room evidence still needed."},
  ];
  await runAgent("Scout the Canal showroom", {
    allowImport: true,
    activity() {},
    onEvidence(value) { evidence = value; },
    async api(path) {
      if (path.startsWith("/api/locations?"))
        return {mode: "full", rows: [{property_id: 1, name: "Canal showroom", models: {Canal: "Showroom"}}]};
      if (path.startsWith("/api/rooms?")) return [];
      if (path === "/api/import-room") throw Error("No closed room outlines.");
      assert.equal(path, "/api/agent-turn");
      return turns.shift();
    },
  });
  assert.deepEqual(evidence.unverifiedLeads[0].scans,
    [{model: "Canal", caption: "Showroom", importError: "No closed room outlines."}]);
});

test("explicit brief values can fill the lens and minimum travel controls", () => {
  assert.deepEqual(briefSuggestions("A 35 mm lens and at least 0.7 m of camera travel"),
    {lens: 35, minimumTravel: .7});
  assert.deepEqual(briefSuggestions("Try a 35 mm lens or a 50 mm lens, around 1 m of travel"),
    {lens: null, minimumTravel: null});
  assert.equal(briefSuggestions("A 35.5 mm lens").lens, null);
});

test("shortlist-only runs retain scans with missing room evidence", async () => {
  let evidence;
  const turns = [{tool_calls: ["Ready", "Missing"].map(model => ({
    id: model,
    function: {name: "inspect_location", arguments: JSON.stringify({model})},
  }))}, {content: "One scan has a room."}];
  await runAgent("Check my shortlist", {
    shortlist: [
      {modelId: "Ready", label: "Ready room", caption: "Tour"},
      {modelId: "Missing", label: "Missing room", caption: "Showroom"},
    ],
    activity() {},
    onEvidence(value) { evidence = value; },
    async api(path) {
      if (path === "/api/rooms?model=Ready") return [{id: "room"}];
      if (path === "/api/rooms?model=Missing") return [];
      assert.equal(path, "/api/agent-turn");
      return turns.shift();
    },
  });
  assert.deepEqual(evidence.unverifiedLeads.map(lead => lead.scans[0].model), ["Missing"]);
});
