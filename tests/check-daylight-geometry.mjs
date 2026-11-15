import assert from "node:assert/strict";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createRelight} from "../site/relight.js";
import {interiorStudy} from "../site/daylight.js";

const THREE = await import(pathToFileURL(resolve(process.argv[2], "build/three.module.js")).href);
const mesh = new THREE.Group();
const mat = new THREE.MeshBasicMaterial({side: THREE.DoubleSide});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), mat);
floor.rotation.x = -Math.PI / 2;
mesh.add(floor);
const glazing = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), mat);
glazing.position.set(0, 1.5, 3);
mesh.add(glazing);
mesh.updateMatrixWorld(true);
const profile = {windows: [{id: "south", outward: [0,0,1], corners: [[-1,1,3],[1,1,3],[1,2,3],[-1,2,3]]}]};
const makeFrame = (y, distances) => ({
  sun: {direction: [0, y, Math.sqrt(1 - y*y)]},
  windows: [{id: "south", status: "exterior-unknown", actorApertureMeters: distances}],
});
const position = [0, 1, 2];
const frame = makeFrame(.45, [1 / Math.sqrt(1 - .45*.45), null]);
const outcome = interiorStudy(THREE, mesh, profile, frame, [position, [5,1,2]]);
assert.ok(outcome.triangles.length > 0);
assert.ok(outcome.floorTriangles.length > 0);
assert.deepEqual(outcome.exposure, [{lit:true, conditional:true}, {lit:false, conditional:false}]);
const steeper = interiorStudy(THREE, mesh, profile, makeFrame(.7, []), []);
assert.notDeepEqual(steeper.triangles, outcome.triangles);
glazing.position.z = 3.12;
mesh.updateMatrixWorld(true);
const recessed = interiorStudy(THREE, mesh, profile, frame, [position, [5,1,2]]);
assert.deepEqual(recessed.floorTriangles, outcome.floorTriangles);
const noPatch = interiorStudy(THREE, mesh, profile, frame, [position, [5,1,2]], {projectPatch: false});
assert.deepEqual(noPatch.exposure, recessed.exposure);
assert.equal(noPatch.triangles.length, 0);
assert.equal(noPatch.floorTriangles.length, 0);
const obstruction = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), mat);
obstruction.position.set(0, 1, 2.92);
mesh.add(obstruction);
mesh.updateMatrixWorld(true);
assert.equal(interiorStudy(THREE, mesh, profile, frame, [position]).exposure[0].lit, false);
console.log("Verified moving beam, recessed glazing, nearby interior obstruction, and exposure-only mode.");

const scene = new THREE.Scene();
const fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 2);
const marks = new THREE.Group();
const standIn = new THREE.Group();
const actorMaterial = new THREE.MeshStandardMaterial();
const body = new THREE.Mesh(new THREE.BoxGeometry(.3, 1, .3), actorMaterial);
standIn.add(body);
marks.add(standIn);
scene.add(mesh, marks, fill);
globalThis.document = {createElement: () => ({getContext: () => null})};
const renderer = {shadowMap: {enabled: false}};
const distant = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
distant.position.set(1000, 20, 1000);
mesh.add(distant);
const relight = createRelight(THREE, mesh, fill, scene, renderer, marks, {
  height: 6, outline: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
});
const light = scene.children.find(object => object.isDirectionalLight);
assert.ok(light.shadow.camera.right < 10);
assert.ok(light.shadow.camera.top > 3);
relight.set({...frame, sun: {...frame.sun, elevation: 30}}, profile);
assert.notEqual(body.material, actorMaterial);
assert.equal(body.castShadow, true);
const added = new THREE.Mesh(new THREE.BoxGeometry(.3, 1, .3), actorMaterial);
standIn.add(added);
relight.syncActors();
assert.equal(added.material, body.material);
relight.set(null);
assert.equal(body.material, actorMaterial);
assert.equal(added.material, actorMaterial);
assert.equal(body.castShadow, false);
assert.equal(renderer.shadowMap.enabled, false);
relight.dispose();
console.log("Verified nested and newly added actor meshes restore their photographed materials.");
