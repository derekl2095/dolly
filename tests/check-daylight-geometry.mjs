import assert from "node:assert/strict";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
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
const profile = {windows: [{id: "south", corners: [[-1,1,3],[1,1,3],[1,2,3],[-1,2,3]]}]};
const makeFrame = (y, distances) => ({
  sun: {direction: [0, y, Math.sqrt(1 - y*y)]},
  windows: [{id: "south", status: "exterior-unknown", actorApertureMeters: distances}],
});
const position = [0, 1, 2];
const frame = makeFrame(.45, [1 / Math.sqrt(1 - .45*.45), null]);
const outcome = interiorStudy(THREE, mesh, profile, frame, [position, [5,1,2]]);
assert.ok(outcome.triangles.length > 0);
assert.deepEqual(outcome.exposure, [{lit:true, conditional:true}, {lit:false, conditional:false}]);
const steeper = interiorStudy(THREE, mesh, profile, makeFrame(.7, []), []);
assert.notDeepEqual(steeper.triangles, outcome.triangles);
const obstruction = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), mat);
obstruction.position.set(0, 1, 2.5);
mesh.add(obstruction);
mesh.updateMatrixWorld(true);
assert.equal(interiorStudy(THREE, mesh, profile, frame, [position]).exposure[0].lit, false);
console.log("Verified moving beam, glazing aperture, and interior obstruction.");
