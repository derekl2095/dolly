# Cursor handoff — Greenway window detection

## Goal

Improve automatic MatterPak window detection so five visible panes in the supplied Greenway reference can become five distinct, accurate review candidates. Return a console or UI confidence explanation and preserve a human review step before applying candidates to sunlight. Never overwrite the saved profile as part of a detection run.

## Checkout and reproduction

- Check out `scout/daylight` and pull the latest commit. The cached MatterPak and daylight calibration live locally on the Mac used for testing.
- The preview was running on port 8017. Open `http://127.0.0.1:8017/?model=39kv7R6xV7o&name=Twelve+Greenway+Plaza`. If needed, start `python3 app.py --port 8017` from the checkout. The existing Greenway MatterPak is in `mesh-cache/39kv7R6xV7o/`. No credentials are necessary for the cached scan.
- Open **Room data and alignment → Direct sunlight → Suggest windows**. Cyan is a candidate. Gold is a draft or saved aperture. The saved profile contains older false positives, so leave **Show marked windows** off when evaluating automatic detection.
- Use the five-pane reference screenshot from the source chat. It shows a partial bright pane at far left, a narrower dark pane past a column, a pane showing the outside building, a large dark center pane, and a dark right pane partly occluded by furniture. The current 15 mm shot in the app may show a different portion of the window bank.

## What was tried

- `site/window-detection.js` now renders a geometry mask and photographed textures for each outline edge. It scores framed mesh openings, dark panes bounded by solid brighter surfaces, and plausible neighbors along a known sill/header. It scans head-on and at ±27° using a sheared projection, so candidates from one wall share coordinates. It maps quads to the nominal outline wall plane.
- The best Greenway run returned **three** candidates. It usually recognizes the central dark pane. It also proposes a narrow crop within the textured pane to its left and a candidate for the pane to its right, with imperfect divider placement. Oblique views gave overlapping alternatives and did not raise the count to five.
- The latest local change in `site/daylight.js` lets a user mark four corners even when clicking on black gaps in the scan. The first click chooses the nearest facing wall plane, and subsequent corners are projected onto the same plane. It derives the outward direction from outline winding. I've verified in the live browser that manually marking the dark right-hand pane produces a correctly placed gold draft box. No changes were saved to the real calibration.
- Greenway's true-north heading is still provisional. Even good window shapes don't establish accurate clock-time predictions without a verified heading.

## Next implementation pass

1. Capture per-wall raster diagnostics from the real model before changing thresholds. Render the wall in rectified coordinates and retain RGB, occupancy, along-wall coordinates, and the depth offset from the nominal wall if available. Draw every proposed candidate, including rejected candidates with their rejection reasons. Use a taller framing extent if the raster cuts off headers.
2. Identify the physical walls and recesses containing the five reference panes. Compare the projected outline edge with the visible frames. The current ±27° shear changes occlusion but intentionally does not move the crop past either end of the outline segment. That may explain why a pane disappears at the column or corner. Test overlapping padded crops, keeping candidates that fall on either neighboring plane when appropriate. Check whether recessed window frames require wall depth estimated from the scan instead of sticking to the floor-plan plane.
3. Segment a window row by persistent mullion lines from sill to header. Use mesh gaps for black panes and photo/mesh appearance for the bright panes. Split on an interior mullion that persists over most of the height before merging across views. Penalize proposals that stop at a texture edge inside a pane. Deduplicate only candidates on the same plane that agree on the opening, without combining adjacent panes.
4. If the heuristic still misses panes, evaluate image segmentation on the existing local textures or rectified screenshots, then project the masks back to their scan planes. Check the sponsor data terms before submitting captured images to an external model. There is no dependency on another MatterPak download for Greenway.

## Acceptance

- In the browser, verify five distinct review candidates against the reference or several views that show the complete bank. Reject proposals across the solid column and wall. Record failures explicitly if any pane still requires manual marking.
- Verify one bright glass pane and one dark pane. Check that each quad stays on one wall plane and its sign points outward. Toggle the photographed view and verify the overlays are still registered.
- Run `node --test site/*.test.js tests/*.test.mjs` and `python3 -m unittest discover -s tests` from the checkout. Add a detector regression fixture that includes both a bright pane and a dark pane separated by a mullion. Keep the manual override available.
