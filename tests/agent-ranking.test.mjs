import assert from "node:assert/strict";
import test from "node:test";
import {briefSuggestions, reviewShotBrief, runAgent} from "../site/agent.js";

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
  assert.deepEqual(evidence.coverage, {propertiesFound: 3, shortlistedScans: null, roomsEvaluated: 2});
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

test("missing mesh alignment cannot be bypassed by an agent retry", async () => {
  const room = {
    modelId: "OutlineOnly", outline: [[-3, -6], [3, -6], [3, 6], [-3, 6]],
    camera: [0, 4], lookAt: [0, 0], actors: [[-.5, 0], [.5, 0]], slideAxis: [1, 0],
  };
  const call = (name, args, id = name) => ({id, function: {name, arguments: JSON.stringify(args)}});
  const evaluate = (lens, id) => call("evaluate_shot", {
    model: room.modelId, room: null, lens, slide: .7, move: "slide", requireSightlines: false,
  }, id);
  let round = 0;
  let evidence;
  let alternatives;
  await runAgent("Find a two-shot with verified sightlines", {
    shortlist: [{modelId: room.modelId}], requireSightlines: true, allowApply: true,
    activity() {},
    onEvidence(value) { evidence = value; },
    onAlternatives(value) { alternatives = value; },
    apply() { assert.fail("An unaligned scan cannot pass the required sightline check"); },
    async api(path, options) {
      if (path.startsWith("/api/room?")) return room;
      assert.equal(path, "/api/agent-turn");
      if (round++ === 0) return {tool_calls: [
        call("get_room_evidence", {model: room.modelId, room: null}),
        evaluate(35, "first"), evaluate(28, "retry"),
      ]};
      if (round === 2) return {tool_calls: [call("apply_shot", {candidate: "shot-2"})]};
      const result = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      assert.match(result.error, /passed the available checks/);
      return {content: "No qualifying setup."};
    },
  });
  assert.equal(evidence.candidates.length, 2);
  assert.ok(evidence.candidates.every(candidate => candidate.status === "missing-evidence" &&
    candidate.missingEvidence.includes("captured sightlines") &&
    /alignment unverified/i.test(candidate.outcome)));
  assert.equal(evidence.recommended, undefined);
  assert.deepEqual(alternatives, []);
});

test("a provider failure clears an unapplied proposal and keeps the active shot", async () => {
  let round = 0;
  let evidence;
  const call = (name, args) => ({id: name, function: {name, arguments: JSON.stringify(args)}});
  const summary = await runAgent("Check my current shot", {
    current: {lens: 35, travel: 1}, allowApply: true,
    activity() {},
    onEvidence(value) { evidence = value; },
    revise() { return {setup: {travel: 1}, reason: "Checked"}; },
    apply() { assert.fail("An incomplete run must keep the active shot"); },
    async api() {
      if (round++ === 0) return {tool_calls: [
        call("revise_current_shot", {objective: "travel"}), call("apply_shot", {candidate: "shot-1"}),
      ]};
      assert.equal(evidence.queued, "shot-1");
      throw Error("The provider did not respond.");
    },
  });
  assert.match(summary, /provider did not respond.*active shot was kept/i);
  assert.equal(evidence.queued, undefined);
  assert.equal(evidence.recommended, "shot-1");
});

test("continuing a confirmed-outline search preserves hard filters and includes later leads", async () => {
  let turn = 0;
  let evidence;
  const calls = ["search_locations", "continue_location_search"];
  const offsets = [];
  await runAgent("Find a Houston office", {
    catalogFilters: {city: "Houston", category: "office"}, activity() {},
    onEvidence(value) { evidence = value; },
    async api(path) {
      if (path.startsWith("/api/locations?")) {
        const params = new URL(path, "http://localhost").searchParams;
        assert.equal(params.get("city"), "Houston");
        assert.equal(params.get("category"), "office");
        assert.equal(params.get("confirmed"), "1");
        assert.equal(params.has("imported"), false);
        assert.equal(params.get("q"), "showroom");
        assert.equal(params.get("limit"), "6");
        const offset = Number(params.get("offset") ?? 0);
        offsets.push(offset);
        return {rows: [{property_id: offset + 1, models: {}}],
          mode: "full", next_offset: offset ? null : 6};
      }
      if (turn === calls.length) return {content: "Found two leads."};
      const name = calls[turn++];
      return {tool_calls: [{id: name, function: {name, arguments: '{"query":"showroom","confirmedOnly":true}'}}]};
    },
  });
  assert.deepEqual(offsets, [0, 6]);
  assert.deepEqual(evidence.unverifiedLeads.map(lead => lead.id), [1, 7]);
});

test("an agent downloads its preferred capture and opens the next qualifying scan if needed", async () => {
  const models = ["First", "Second"];
  const call = (name, args) => ({
    id: name + args.model, function: {name, arguments: JSON.stringify(args)},
  });
  const turns = [
    {tool_calls: models.map(model => call("get_room_evidence", {model, room: "room"}))},
    {tool_calls: models.map(model => call("evaluate_shot", {model, room: "room",
      lens: 35, slide: .7, move: "slide", requireSightlines: false}))},
    {tool_calls: [call("apply_shot", {candidate: "shot-1"})]},
    {content: "Checked both setups."},
  ];
  const imports = [];
  let opened;
  const result = await runAgent("Scout a slide", {
    shortlist: models.map(modelId => ({modelId})), allowImport: true, allowApply: true,
    activity() {},
    apply(room, setup, captureRequired) { opened = {model: room.modelId, setup, captureRequired}; },
    async api(path, options) {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/agent-turn") return turns.shift();
      if (url.pathname === "/api/import-matterpak") {
        const {model} = JSON.parse(options.body);
        imports.push(model);
        if (model === "First") throw Error("No ZIP available.");
        return {cached: false};
      }
      assert.equal(url.pathname, "/api/room");
      return {modelId: url.searchParams.get("model"), roomId: "room", height: 3,
        outline: [[-3,-6],[3,-6],[3,6],[-3,6]], camera: [0,4], lookAt: [0,0],
        actors: [[-.5,0],[.5,0]], slideAxis: [1,0]};
    },
  });
  assert.deepEqual(imports, models);
  assert.equal(opened.model, "Second");
  assert.equal(opened.captureRequired, true);
  assert.equal(opened.setup.lens, 35);
  assert.match(result, /Opened shot-2/);
});

test("agent retries a failed candidate and opens a tested shot without changing its lens or staging", async () => {
  const model = "Office";
  const room = {
    modelId: model, roomId: "room", height: 3,
    outline: [[-6, -6], [6, -6], [6, 6], [-6, 6]],
    camera: [0, 2], lookAt: [0, 0], actors: [[-.75, 0], [.75, 0]], slideAxis: [1, 0],
  };
  const call = (name, args) => ({
    id: name, function: {name, arguments: JSON.stringify(args)},
  });
  const responses = [
    {tool_calls: [call("get_room_evidence", {model, room: "room"})]},
    {tool_calls: [call("evaluate_shot", {model, room: "room", lens: 35, move: "slide", slide: 1})]},
    {tool_calls: [call("retry_candidate", {candidate: "shot-1", adjustment: "back_up", meters: 2})]},
    {tool_calls: [call("apply_shot", {candidate: "shot-2"})]},
    {content: "Checked the backed-up camera."},
  ];
  let opened;
  let evidence;
  await runAgent("Keep the 35 mm lens and both actors in frame throughout a 1 m slide.", {
    shortlist: [{modelId: model}], lockedLens: 35, lockedMove: "slide",
    allowApply: true, minimumTravel: 1, activity() {},
    onEvidence(value) { evidence = value; },
    apply(_room, setup) { opened = setup; },
    async api(path) { return path.startsWith("/api/room?") ? room : responses.shift(); },
  });
  assert.equal(evidence.candidates.find(item => item.id === "shot-1").status, "failed");
  assert.equal(evidence.candidates.find(item => item.id === "shot-2").parent, "shot-1");
  assert.equal(opened.lens, 35);
  assert.equal(opened.travel, 1);
  assert.deepEqual(opened.mark, [0, 4]);
  assert.deepEqual(opened.aim, room.lookAt);
  assert.deepEqual(opened.actors, room.actors);
});

test("agent presents a recommendation and at most two alternatives from distinct rooms", async () => {
  const models = ["First", "Second", "Third", "Fourth"];
  const call = (name, args, id = name + args.model) => ({
    id, function: {name, arguments: JSON.stringify(args)},
  });
  const evaluation = (model, id) => call("evaluate_shot", {model, room: "room", lens: 35,
    move: "slide", slide: .7}, id);
  const responses = [
    {tool_calls: models.map(model => call("get_room_evidence", {model, room: "room"}))},
    {tool_calls: models.map(model => evaluation(model, "check-" + model))},
    {tool_calls: [evaluation("First", "repeat-First"), evaluation("Second", "repeat-Second")]},
    {tool_calls: [call("apply_shot", {candidate: "shot-1"}, "apply-first")]},
    {content: "Compared rooms."},
  ];
  let alternatives;
  let opened;
  let results;
  await runAgent("Find a room for a 35 mm slide.", {
    shortlist: models.map(modelId => ({modelId})), allowApply: true,
    activity() {}, onAlternatives(value) { alternatives = value; },
    onResults(value) { results = value; },
    apply(room) { opened = room.modelId; },
    async api(path) {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/agent-turn") return responses.shift();
      return {modelId: url.searchParams.get("model"), roomId: "room", height: 3,
        outline: [[-3,-6],[3,-6],[3,6],[-3,6]], camera: [0,4], lookAt: [0,0],
        actors: [[-.5,0],[.5,0]], slideAxis: [1,0]};
    },
  });
  assert.equal(opened, "First");
  assert.deepEqual(results.options.map(option => option.room.modelId), ["First", "Second", "Third"]);
  assert.ok(results.options[0].opened);
  assert.deepEqual(alternatives.map(item => item.room.modelId), ["Second", "Third"]);
});

test("agent can reuse a scan download when the first room fails to open", async () => {
  const model = "Office";
  const rooms = ["first", "second", "third"];
  const call = (name, room, args) => ({
    id: name + room, function: {name, arguments: JSON.stringify(args)},
  });
  const responses = [
    {tool_calls: rooms.map(room => call("get_room_evidence", room, {model, room}))},
    {tool_calls: rooms.map(room => call("evaluate_shot", room, {model, room, lens: 35,
      move: "slide", slide: .7}))},
    {tool_calls: [call("apply_shot", "first", {candidate: "shot-1"})]},
    {content: "Compared rooms."},
  ];
  let downloads = 0;
  const opened = [];
  let alternatives;
  let evidence;
  await runAgent("Find an office for a 35 mm slide.", {
    shortlist: [{modelId: model}], allowApply: true, allowImport: true, activity() {},
    onAlternatives(value) { alternatives = value; },
    onEvidence(value) { evidence = value; },
    apply(room) {
      opened.push(room.roomId);
      if (room.roomId === "first") throw Object.assign(Error("Room failed alignment."), {code: "capture-unavailable"});
    },
    async api(path) {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/agent-turn") return responses.shift();
      if (url.pathname === "/api/import-matterpak") {
        downloads++;
        return {cached: false};
      }
      assert.equal(url.pathname, "/api/room");
      return {modelId: model, roomId: url.searchParams.get("room"), height: 3,
        outline: [[-3,-6],[3,-6],[3,6],[-3,6]], camera: [0,4], lookAt: [0,0],
        actors: [[-.5,0],[.5,0]], slideAxis: [1,0]};
    },
  });
  assert.equal(downloads, 1);
  assert.deepEqual(opened, ["first", "second"]);
  assert.equal(evidence.recommended, "shot-2");
  assert.deepEqual(alternatives.map(item => item.room.roomId), ["third"]);
});

test("review interprets a push-in without inventing numeric constraints", async () => {
  let calls = 0;
  const draft = await reviewShotBrief("Start wide and drift closer without losing either actor.", {
    async api(path, options) {
      calls++;
      assert.equal(path, "/api/agent-turn");
      const payload = JSON.parse(options.body);
      assert.equal(payload.tool_choice, "required");
      assert.deepEqual(payload.tools.map(tool => tool.function.name), ["review_shot_brief"]);
      return {tool_calls: [{function: {name: "review_shot_brief", arguments: JSON.stringify({
        move: "push", lens: 35, targetTravel: 1, minimumTravel: .5, scope: null,
      })}}]};
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(draft, {move: "push", lens: null, targetTravel: null, minimumTravel: null, scope: null});
});

test("review accepts explicit values and surfaces provider unavailability", async () => {
  const brief = "35 mm push-in, ideally 1 meter and at least 60 cm. Stay in this room.";
  const draft = await reviewShotBrief(brief, {api: async () => ({
    tool_calls: [{function: {name: "review_shot_brief", arguments: JSON.stringify({
      move: "push", lens: 35, targetTravel: 1, minimumTravel: .6, scope: "current_room",
    })}}],
  })});
  assert.deepEqual(draft, {move: "push", lens: 35, targetTravel: 1, minimumTravel: .6, scope: "current_room"});
  await assert.rejects(reviewShotBrief(brief, {api: async () => { throw Error("Provider offline"); }}),
    /Provider offline/);
});

test("an unqualified shot stays a measured tradeoff with no playable action", async () => {
  const call = {id: "revise", function: {name: "revise_current_shot",
    arguments: JSON.stringify({slide: 1, lens: null, cameraHeight: null, objective: "travel"})}};
  const turns = [{tool_calls: [call]}, {content: "Checked the open room."}];
  let results;
  await runAgent("Keep this room and get at least 1 m of travel.", {
    current: {lens: 35, travel: .7, moveKind: "slide"}, currentModel: "Current", minimumTravel: 1,
    allowApply: true, activity() {}, onResults(value) { results = value; },
    revise: () => ({setup: {travel: .8}, reason: "Room wall limits travel."}),
    apply() { assert.fail("An unqualified setup must never apply."); },
    async api() { return turns.shift(); },
  });
  assert.deepEqual(results.options, []);
  assert.deepEqual(results.tradeoff.unmet, ["Minimum travel"]);
  assert.equal(results.tradeoff.travel, .8);
});
