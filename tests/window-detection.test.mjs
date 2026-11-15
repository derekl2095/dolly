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

test("a bright pane and a dark pane split on a full-height mullion, not on a short texture edge", async () => {
  const {splitWindowRow} = await import("../site/window-detection.js");
  const size = 96;
  const pixels = new Uint8Array(size * size * 4).fill(176);
  const mask = new Uint8Array(pixels.length).fill(255);
  const y = 29, top = 74;
  for (let row = y; row < top; row++) {
    for (let x = 12; x < 40; x++) pixels.set([60, 115, 185, 255], (row * size + x) * 4);
    for (let x = 40; x < 46; x++) pixels.set([230, 230, 230, 255], (row * size + x) * 4);
    for (let x = 46; x < 78; x++) pixels.set([12, 12, 12, 255], (row * size + x) * 4);
  }
  const split = splitWindowRow(pixels, mask, size, {x: 1, right: size - 1, y, top}, 9, 8);
  assert.equal(split.panes.length, 2);
  assert.equal(split.panes[0].kind, "Bright glass pane");
  assert.equal(split.panes[1].kind, "Dark pane");
  assert.ok(Math.abs(split.panes[0].x - 12) <= 2);
  assert.ok(Math.abs(split.panes[1].right - 78) <= 2);
  for (let row = y + 16; row < y + 24; row++)
    for (let x = 28; x < 32; x++) pixels.set([240, 240, 240, 255], (row * size + x) * 4);
  const unsplit = splitWindowRow(pixels, mask, size, {x: 12, right: 40, y, top}, 9, 8);
  assert.equal(unsplit.panes.length, 1);
  const darkFrame = new Uint8Array(size * size * 4).fill(176);
  for (let row = y; row < top; row++) {
    for (let x = 16; x < 42; x++) darkFrame.set([70, 130, 190, 255], (row * size + x) * 4);
    for (let x = 42; x < 45; x++) darkFrame.set([18, 18, 18, 255], (row * size + x) * 4);
    for (let x = 45; x < 74; x++) darkFrame.set([190, 150, 90, 255], (row * size + x) * 4);
  }
  const framed = splitWindowRow(darkFrame, mask, size, {x: 1, right: size - 1, y, top}, 9, 8);
  assert.equal(framed.panes.length, 2);
  assert.equal(framed.panes.every(pane => pane.kind === "Bright glass pane"), true);
});

test("a soft mullion and a wide pier split panes without a hard brightness edge", async () => {
  const {splitWindowRow} = await import("../site/window-detection.js");
  const size = 96;
  const mask = new Uint8Array(size * size * 4).fill(255);
  const y = 29, top = 74;
  const paint = (image, from, to, color) => {
    for (let row = y; row < top; row++)
      for (let x = from; x < to; x++) image.set([...color, 255], (row * size + x) * 4);
  };
  const soft = new Uint8Array(size * size * 4).fill(80);
  paint(soft, 12, 40, [80, 80, 80]);
  paint(soft, 40, 43, [98, 98, 98]);
  paint(soft, 43, 78, [80, 80, 80]);
  const split = splitWindowRow(soft, mask, size, {x: 1, right: size - 1, y, top}, 9, 8, {trustOpening: true});
  assert.equal(split.panes.length, 2);
  assert.ok(Math.abs(split.panes[0].right - 40) <= 2);
  assert.ok(Math.abs(split.panes[1].x - 43) <= 2);
  const pier = new Uint8Array(size * size * 4).fill(70);
  paint(pier, 8, 28, [70, 70, 70]);
  paint(pier, 28, 46, [220, 220, 220]);
  paint(pier, 46, 74, [16, 16, 16]);
  const separated = splitWindowRow(pier, mask, size, {x: 1, right: size - 1, y, top}, 9, 8, {trustOpening: true});
  assert.equal(separated.panes.length, 2);
  assert.equal(separated.panes[1].kind, "Dark pane");
  assert.ok(separated.rejected.some(item => item.reason === "solid column or wall"));
});

test("missing MatterPak mesh is a window and a solid pier keeps two openings apart", async () => {
  const {meshGapPanes} = await import("../site/window-detection.js");
  const size = 96;
  const mask = new Uint8Array(size * size * 4).fill(255);
  const clear = (x0, x1, y0, y1) => {
    for (let y = y0; y < y1; y++) mask.fill(0, (y * size + x0) * 4, (y * size + x1) * 4);
  };
  clear(18, 40, 28, 70);
  clear(52, 78, 28, 70);
  const split = meshGapPanes(mask, size, 8, 20, 60, 3);
  assert.equal(split.panes.length, 2);
  assert.equal(split.panes.every(pane => pane.kind === "Mesh opening"), true);
  const ordered = split.panes.slice().sort((a, b) => a.x - b.x);
  assert.ok(Math.abs(ordered[0].x - 18) <= 1);
  assert.ok(Math.abs(ordered[0].right - 40) <= 1);
  assert.ok(Math.abs(ordered[1].x - 52) <= 1);
  const patchy = new Uint8Array(mask);
  for (let y = 28; y < 40; y++) patchy.fill(0, (y * size + 84) * 4, (y * size + 96) * 4);
  for (let y = 55; y < 70; y++) patchy.fill(0, (y * size + 84) * 4, (y * size + 96) * 4);
  const withPartial = meshGapPanes(patchy, size, 8, 20, 60, 3);
  const partial = withPartial.panes.find(pane => pane.x >= 82 && pane.x <= 88);
  assert.ok(partial, "a partly missing pane in the same row is kept");
  assert.ok(partial.right - partial.x >= 8);
  const blown = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < 70; y++) blown.fill(0, (y * size + 20) * 4, (y * size + 50) * 4);
  const clipped = meshGapPanes(blown, size, 8, 20, 40, 3, 0, size, 0, .03);
  assert.equal(clipped.panes.length, 1);
  assert.ok(clipped.panes[0].y > 10, "the opening stays above the floor");
  clear(0, size, 0, 28);
  const doorway = meshGapPanes(mask, size, 8, 20, 80, 3);
  assert.equal(doorway.panes.length, 0);
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
