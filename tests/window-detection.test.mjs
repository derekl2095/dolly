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
  const unframed = meshGapPanes(blown, size, 8, 20, 40, 3, 0, size, 0, .03);
  assert.equal(unframed.panes.length, 0, "a floor-to-header hole with no sill is not a window");
  const framed = new Uint8Array(size * size * 4).fill(255);
  for (let y = 25; y < 70; y++) framed.fill(0, (y * size + 20) * 4, (y * size + 50) * 4);
  const clipped = meshGapPanes(framed, size, 8, 20, 40, 3, 0, size, 0, .03);
  assert.equal(clipped.panes.length, 1);
  assert.ok(clipped.panes[0].y > 10, "a sill and a header keep the window band");
  clear(0, size, 0, 28);
  const doorway = meshGapPanes(mask, size, 8, 20, 80, 3);
  assert.equal(doorway.panes.length, 0);
});

test("photographed glass is darker than its sill, and a flat wall is not", async () => {
  const {scannedGlazing} = await import("../site/window-detection.js");
  const size = 96;
  const mask = new Uint8Array(size * size * 4).fill(255);
  const paint = (image, x0, x1, y0, y1, color) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) image.set([...color, 255], (y * size + x) * 4);
  };
  const wall = new Uint8Array(size * size * 4).fill(180);
  const flat = scannedGlazing(wall, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(flat.panes.length, 0);
  const glass = new Uint8Array(wall);
  paint(glass, 20, 52, 30, 70, [30, 36, 48]);
  const pane = scannedGlazing(glass, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(pane.panes.length, 1);
  assert.ok(Math.abs(pane.panes[0].x - 20) <= 1);
  const throughFloor = new Uint8Array(glass);
  paint(throughFloor, 20, 52, 12, 30, [30, 36, 48]);
  const doorway = scannedGlazing(throughFloor, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(doorway.panes.length, 0);
  const blinds = new Uint8Array(wall);
  for (let y = 30; y < 70; y++)
    paint(blinds, 24, 60, y, y + 1, y % 2 ? [28, 28, 28] : [150, 150, 150]);
  const slatted = scannedGlazing(blinds, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(slatted.panes.length, 1);
  const sunlit = new Uint8Array(wall);
  paint(sunlit, 20, 52, 30, 70, [235, 232, 220]);
  const bright = scannedGlazing(sunlit, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(bright.panes.length, 1);
  const washed = new Uint8Array(wall);
  paint(washed, 4, 92, 30, 70, [235, 232, 220]);
  const wholeWall = scannedGlazing(washed, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(wholeWall.panes.length, 0);
  const bank = new Uint8Array(wall);
  paint(bank, 16, 40, 30, 70, [235, 232, 220]);
  paint(bank, 40, 43, 30, 70, [30, 30, 30]);
  paint(bank, 43, 70, 30, 70, [230, 228, 216]);
  const splitBank = scannedGlazing(bank, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(splitBank.panes.length, 2);
  const ceiling = new Uint8Array(size * size * 4).fill(210);
  paint(ceiling, 30, 33, 0, size, [20, 20, 20]);
  paint(ceiling, 55, 58, 0, size, [20, 20, 20]);
  const fullHeight = scannedGlazing(ceiling, mask, size, 8, 12, 4, 92, 30, 70);
  assert.ok(fullHeight.panes.length >= 2, "bright panes between mullions need no darker sill");
  const graded = new Uint8Array(wall);
  for (let x = 12; x < 80; x++) {
    const tone = 150 + Math.round((x - 12) / 68 * 80);
    paint(graded, x, x + 1, 30, 70, [tone, tone, tone]);
  }
  const wash = scannedGlazing(graded, mask, size, 8, 12, 4, 92, 30, 70);
  assert.ok(wash.panes.every(pane => pane.right - pane.x < 24), "light that fades across a wall is not a wide pane");
  const matched = new Uint8Array(size * size * 4).fill(120);
  for (let y = 30; y < 70; y++)
    paint(matched, 24, 58, y, y + 1, y % 2 ? [40, 40, 40] : [200, 200, 200]);
  paint(matched, 21, 24, 30, 70, [30, 30, 30]);
  paint(matched, 58, 61, 30, 70, [30, 30, 30]);
  const evenBlinds = scannedGlazing(matched, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(evenBlinds.panes.length, 1, "slats inside a frame stay a window when they match the wall");
  const continued = new Uint8Array(wall);
  paint(continued, 20, 52, 30, size, [230, 228, 220]);
  const litWall = scannedGlazing(continued, mask, size, 8, 12, 4, 92, 30, 70);
  assert.equal(litWall.panes.length, 0, "a bright patch that continues above the band is the wall");
});

test("mullioned voids are panes and one missing wall is not", async () => {
  const {framedVoidPanes} = await import("../site/window-detection.js");
  const size = 96;
  const mask = new Uint8Array(size * size * 4).fill(255);
  const clear = (x0, x1) => {
    for (let y = 20; y < 70; y++) mask.fill(0, (y * size + x0) * 4, (y * size + x1) * 4);
  };
  clear(16, 36);
  clear(42, 68);
  const split = framedVoidPanes(mask, size, 8, 4, 92, 20, 70);
  assert.equal(split.length, 2);
  const gone = new Uint8Array(size * size * 4);
  assert.equal(framedVoidPanes(gone, size, 8, 4, 92, 20, 70).length, 0);
});

test("a mesh hole is a window when it is a void or daylight, and a doorway when it shows a room", async () => {
  const {openingLooksLikeWindow} = await import("../site/window-detection.js");
  const size = 96;
  const mask = new Uint8Array(size * size * 4).fill(255);
  const pixels = new Uint8Array(size * size * 4).fill(150);
  const pane = {x: 30, right: 52, y: 28, top: 68};
  for (let y = pane.y; y < pane.top; y++) mask.fill(0, (y * size + pane.x) * 4, (y * size + pane.right) * 4);
  for (let y = pane.y; y < pane.top; y++) pixels.fill(8, (y * size + pane.x) * 4, (y * size + pane.right) * 4);
  assert.equal(openingLooksLikeWindow(pixels, mask, size, pane), true);
  pixels.fill(210, 0);
  for (let y = 0; y < size; y++) pixels.fill(140, (y * size) * 4, (y * size + pane.x) * 4);
  for (let y = 0; y < size; y++) pixels.fill(140, (y * size + pane.right) * 4, (y * size + size) * 4);
  assert.equal(openingLooksLikeWindow(pixels, mask, size, pane), true);
  pixels.fill(150, 0);
  assert.equal(openingLooksLikeWindow(pixels, mask, size, pane), false);
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


test("a gap and photographed glass retain their own pane across registered views", async () => {
  const {mergePaneViews} = await import("../site/window-detection.js");
  const hole = {x: 5, right: 20, y: 10, top: 30, source: "mesh gap", score: 7, view: 0};
  const glass = {x: 22, right: 43, y: 10, top: 30, source: "photographed glass", score: 7, view: 27};
  const merged = mergePaneViews([hole, glass, {...hole, x: 6, view: -27}]);
  assert.deepEqual(merged.map(pane => [pane.source, pane.viewCount]),
    [["mesh gap", 2], ["photographed glass", 1]]);
});

test("window search adapts to low ceilings, tall walls, and measured opening metadata", async () => {
  const {windowSearchScale} = await import("../site/window-detection.js");
  const low = windowSearchScale({height: 2});
  const tall = windowSearchScale({height: 6});
  assert.ok(low.high < 2);
  assert.ok(tall.high > 4);
  assert.ok(tall.maxPaneHeight > 5);
  assert.equal(windowSearchScale({}).elevation, 3);
  assert.ok(windowSearchScale({height: 3}, [{corners: [[0, 4, 0]]}]).elevation > 4);
});

test("texture contrast alone does not establish a window opening", async () => {
  const {paneHasOpeningEvidence} = await import("../site/window-detection.js");
  const glass = {x: 12, right: 25, y: 10, top: 29, source: "Scanned glazing"};
  const opening = {x: 1, right: 9, y: 10, top: 31, source: "Unscanned MatterPak opening"};
  assert.equal(paneHasOpeningEvidence(glass, [glass], [], 20), false);
  assert.equal(paneHasOpeningEvidence(glass, [glass, opening], [], 20), true);
  assert.equal(paneHasOpeningEvidence({...glass, y: 17}, [opening], [], 20), false);
  assert.equal(paneHasOpeningEvidence(glass, [], [{x: 10, right: 26, y: 8, top: 31}], 20), true);
});


test("a short textured pane can use the matching header of two flanking openings", async () => {
  const {extendSharedPaneHeader} = await import("../site/window-detection.js");
  const pane = {x: 25, right: 45, y: 30, top: 59, source: "Scanned glazing"};
  const left = {x: 2, right: 22, y: 30, top: 71, source: "Unscanned MatterPak opening"};
  const right = {x: 48, right: 63, y: 31, top: 70, source: "Unscanned MatterPak opening"};
  assert.equal(extendSharedPaneHeader(pane, [left, right], 25, 25).top, 70);
  assert.equal(extendSharedPaneHeader(pane, [left], 25, 25), pane);
  assert.equal(extendSharedPaneHeader(pane, [left, {...right, top: 64}], 25, 25), pane);
  assert.equal(extendSharedPaneHeader(pane, [left, {...right, y: 40}], 25, 25), pane);
});

test("repeated full-height blind slats provide a texture-only lead without a sill", async () => {
  const {blindPaneCandidates, paneHasOpeningEvidence} = await import("../site/window-detection.js");
  const size = 80, pixels = new Uint8Array(size * size * 4), mask = pixels.slice().fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (y * size + x) * 4;
    const value = x >= 24 && x < 52 ? (Math.floor(y / 5) % 2 ? 115 : 55) : 180;
    pixels.fill(value, at, at + 3);
  }
  const panes = blindPaneCandidates(pixels, mask, size, 3, 77, 3, 77, 12);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].source, "Glazing with repeated blind slats");
  assert.equal(paneHasOpeningEvidence(panes[0], panes, [], 20), false);
});

test("a multi-view sky-and-frame candidate supersedes overlapping texture contrast", async () => {
  const {preferFramedSkyPanes} = await import("../site/window-detection.js");
  const sky = {x: 10, right: 30, y: 10, top: 40, viewCount: 2, source: "Blue sky and photographed window frame"};
  const texture = {x: 24, right: 44, y: 12, top: 38, source: "Scanned glazing"};
  const adjacent = {...texture, x: 32, right: 45};
  const geometry = {...texture, source: "Unscanned MatterPak opening"};
  assert.deepEqual(preferFramedSkyPanes([texture, adjacent, sky, geometry]), [adjacent, sky, geometry]);
  assert.deepEqual(preferFramedSkyPanes([texture, {...sky, viewCount: 1}]), [texture, {...sky, viewCount: 1}]);
});
