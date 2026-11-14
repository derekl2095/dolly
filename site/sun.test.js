import assert from "node:assert/strict";
import test from "node:test";
import {centralOffsetHours, glassGain, modelDirection, sunPosition, sunlight} from "./sun.js";

const houston = {latitude: 29.73301, longitude: -95.4350352};

test("winter noon at Greenway is a low southern sun", () => {
  const sun = sunPosition({...houston, year: 2025, month: 12, day: 31, hour: 12, offsetHours: -6});
  assert.ok(Math.abs(sun.elevation - 36.8) < 0.2);
  assert.ok(Math.abs(sun.azimuth - 173) < 0.5);
});

test("April noon is higher than December noon", () => {
  const april = sunPosition({...houston, year: 2025, month: 4, day: 10, hour: 12, offsetHours: -5});
  const december = sunPosition({...houston, year: 2025, month: 12, day: 31, hour: 12, offsetHours: -6});
  assert.ok(april.elevation > december.elevation + 20);
});

test("central time uses daylight offset on the capture date and standard time in winter", () => {
  assert.equal(centralOffsetHours(2025, 4, 10), -5);
  assert.equal(centralOffsetHours(2025, 12, 31), -6);
});

test("a north-facing plan puts an eastern sun on +x", () => {
  const sun = {east: 1, north: 0, up: 0};
  const direction = modelDirection(sun, 0);
  assert.ok(Math.abs(direction.x - 1) < 1e-9);
  assert.ok(Math.abs(direction.z) < 1e-9);
});

test("the Greenway window is lit only from outside the glass", () => {
  const outward = {x: -1, y: 0, z: 0};
  assert.equal(glassGain({x: -1, y: 0.5, z: 0}, outward), 0.5);
  assert.equal(glassGain({x: 1, y: 0.5, z: 0}, outward), 0);
  assert.equal(glassGain({x: -1, y: -0.2, z: 0}, outward), 0);
});

test("a below-horizon hour does not light the glass", () => {
  const lit = sunlight({
    ...houston, year: 2025, month: 4, day: 10, hour: 4, heading: 0, outward: {x: -1, y: 0, z: 0},
  });
  assert.ok(lit.elevation < 0);
  assert.equal(lit.gain, 0);
});
