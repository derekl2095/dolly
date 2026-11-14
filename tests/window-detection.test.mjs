import assert from "node:assert/strict";
import test from "node:test";
import {frameRectangles} from "../site/window-detection.js";

test("wall imagery proposes a framed opening and ignores a flat wall", () => {
  const size = 96;
  const pixels = new Uint8Array(size*size*4).fill(30);
  assert.deepEqual(frameRectangles(pixels, size), []);
  for (let y = 29; y < 73; y++) for (let x = 22; x < 61; x++) {
    const offset = (y*size+x)*4;
    pixels.fill(230, offset, offset+3);
  }
  const [box] = frameRectangles(pixels, size);
  assert.ok(box);
  for (const [actual, expected] of [[box.x,22],[box.right,61],[box.y,29],[box.top,73]])
    assert.ok(Math.abs(actual-expected) <= 2);
});

test("window evidence requires a mesh opening bounded by solid edges", async () => {
  const {openingEvidence} = await import("../site/window-detection.js");
  const size = 96;
  const box = {x: 22, y: 29, right: 61, top: 73};
  const mesh = new Uint8Array(size * size * 4).fill(255);
  assert.equal(openingEvidence(mesh, size, box), null);
  for (let y = 29; y < 73; y++)
    mesh.fill(0, (y * size + 22) * 4, (y * size + 61) * 4);
  assert.ok(openingEvidence(mesh, size, box) > 1.5);
  for (let y = 29; y < 73; y++)
    mesh.fill(0, y * size * 4, (y * size + 22) * 4);
  assert.equal(openingEvidence(mesh, size, box), null);
});

test("dark framed glazing can be detected even when the mesh fills the opening", async () => {
  const {darkPaneEvidence} = await import("../site/window-detection.js");
  const size = 96;
  const image = new Uint8Array(size * size * 4).fill(160);
  const solid = new Uint8Array(image.length).fill(255);
  const box = {x: 22, y: 29, right: 61, top: 73};
  for (let y = box.y; y < box.top; y++)
    image.fill(15, (y * size + box.x) * 4, (y * size + box.right) * 4);
  assert.ok(frameRectangles(image, size, candidate => darkPaneEvidence(image, solid, size, candidate)).length);
  assert.equal(darkPaneEvidence(image, new Uint8Array(image.length), size, box), null);
  image.fill(15);
  assert.equal(darkPaneEvidence(image, solid, size, box), null);
});

test("a framed opening seeds its dark and colored neighbors without extending into a plain wall", async () => {
  const {adjacentPanes} = await import("../site/window-detection.js");
  const size = 96;
  const pixels = new Uint8Array(size * size * 4).fill(173);
  const mask = new Uint8Array(pixels.length).fill(255);
  const seed = {x: 34, right: 57, y: 29, top: 74};
  for (let y = seed.y; y < seed.top; y++) {
    for (let x = 14; x < 34; x++) pixels.set([60, 115, 185, 255], (y * size + x) * 4);
    for (let x = 57; x < 81; x++) pixels.set([12, 12, 12, 255], (y * size + x) * 4);
  }
  const panes = adjacentPanes(pixels, mask, size, [seed], 9);
  assert.equal(panes.length, 2);
  assert.ok(Math.abs(panes[0].x - 14) <= 2);
  assert.ok(Math.abs(panes[1].right - 81) <= 2);
});

test("wall-registered views combine duplicate suggestions and preserve adjacent panes", async () => {
  const {mergePaneViews} = await import("../site/window-detection.js");
  const first = {x: 20, right: 40, y: 22, top: 82, score: 4, view: 0};
  const results = mergePaneViews([
    first,
    {...first, x: 21, right: 41, view: 27},
    {...first, x: 41, right: 59, view: -27},
  ]);
  assert.deepEqual(results.map(box => box.viewCount), [2, 1]);
  assert.equal(results[0].x, first.x);
});
