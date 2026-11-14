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
