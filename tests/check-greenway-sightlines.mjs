// Run: node tests/check-greenway-sightlines.mjs DATA_DIR THREE_PACKAGE_DIR
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {pathToFileURL} from "node:url";
import {compareCapturedRooms} from "../site/compare.js";
import {alignMesh, sightlineCheck} from "../site/sightlines.js";

const [dataDir, threeDir] = process.argv.slice(2);
if (!dataDir || !threeDir)
  throw Error("Pass the extracted Greenway bundle directory and the Three.js 0.160.0 package directory.");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const fromThree = file => import(pathToFileURL(resolve(threeDir, file)).href);
const THREE = await fromThree("build/three.module.js");
const {OBJLoader} = await fromThree("examples/jsm/loaders/OBJLoader.js");
const room = {
  ...await readJson(join(dataDir, "local-assets/room.json")),
  ...await readJson(new URL("../presets/39kv7R6xV7o.json", import.meta.url)),
};
const captureDir = join(dataDir, "mesh-cache", room.modelId);
const {obj} = await readJson(join(captureDir, "manifest.json"));
const mesh = new OBJLoader().parse(await readFile(join(captureDir, obj), "utf8"));
alignMesh(mesh, room);

const check = sightlineCheck(THREE, mesh, room.actors, room.cameraHeight);
const [x, z] = room.camera;
assert.equal(check([x, z], [x, z]), null);
assert.deepEqual(check([x, z - .35], [x, z + .35]), {actor: 2, t: .75});

const load = async () => ({
  status: "available",
  check: (actors, height) => sightlineCheck(THREE, mesh, actors, height),
});
const [staticShot] = await compareCapturedRooms([room], 35, 0, "static", true, load);
assert.equal(staticShot.status, "pass");
assert.equal(staticShot.sightlinesSampled, true);
console.log("Greenway mesh confirms a clear static shot and an obstruction on the default slide.");
