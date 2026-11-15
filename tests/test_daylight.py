import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import daylight
from app import Handler


WINDOW = {"id": "east", "corners": [[3, 1, -1], [3, 2, -1], [3, 2, 1], [3, 1, 1]],
          "outward": [1, 0, 0], "source": "Measured test opening"}
PROFILE = {"latitude": 29.73, "longitude": -95.44, "heading": 0,
           "timeZone": "America/Chicago", "windows": [WINDOW]}


class DaylightTest(unittest.TestCase):
    def test_solar_reference_and_axes(self):
        at = datetime(2025, 3, 20, 12, tzinfo=timezone.utc)
        north = daylight.solar(at, 40, 0, 0)
        south = daylight.solar(at, -40, 0, 0)
        self.assertAlmostEqual(north["elevation"], 50, delta=1)
        self.assertAlmostEqual(south["elevation"], 50, delta=1)
        self.assertAlmostEqual(north["azimuth"], 180, delta=4)
        self.assertLess(min(south["azimuth"], 360 - south["azimuth"]), 4)
        rotated = daylight.solar(at, 40, 0, 90)
        self.assertAlmostEqual(rotated["direction"][0], -north["direction"][2])
        self.assertAlmostEqual(rotated["direction"][2], north["direction"][0])

    def test_local_calendar(self):
        spring = daylight.instants({"localDate": "2025-03-09"}, "America/Chicago")
        autumn = daylight.instants({"localDate": "2025-11-02"}, "America/Chicago")
        self.assertEqual((len(spring), len(autumn)), (93, 101))
        frames = daylight.study(daylight.profile(PROFILE), spring, [])
        self.assertTrue(frames[0]["localTime"].endswith("-06:00"))
        self.assertTrue(frames[-1]["localTime"].endswith("-05:00"))

    def test_aperture(self):
        self.assertEqual(daylight.aperture_distance([0, 1.5, 0], [1, 0, 0], WINDOW), 3)
        self.assertIsNone(daylight.aperture_distance([0, 3, 0], [1, 0, 0], WINDOW))
        self.assertIsNone(daylight.aperture_distance([0, 1.5, 0], [-1, 0, 0], WINDOW))
        with self.assertRaises(ValueError):
            daylight.profile({**PROFILE, "windows": [WINDOW, WINDOW]})

    def test_dsm_evidence(self):
        window = {**WINDOW, "exterior": {"longitude": 0, "latitude": 0,
                                      "elevationMeters": 10, "datum": "fixture"}}
        sun = {"azimuth": 90, "elevation": 30}
        grid = {"crs": "EPSG:4326", "units": "meters", "datum": "fixture",
                "bounds": [-.002, -.002, .002, .002], "heights": [[0]*100 for _ in range(100)]}
        self.assertEqual(daylight.exterior_status(window, sun, grid), "clear-in-coverage")
        grid["heights"][50][55] = 100
        self.assertEqual(daylight.exterior_status(window, sun, grid), "exterior-blocked")
        grid["heights"][50][55] = None
        self.assertEqual(daylight.exterior_status(window, sun, grid), "exterior-unknown")
        self.assertEqual(daylight.exterior_status(window, sun, {**grid, "datum": "other"}), "exterior-unknown")

    def test_profile_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            h = Handler.__new__(Handler)
            h.respond = lambda status, data: (status, data)
            mesh = ["capture.obj", 123, 9007199254740993]
            room = {"modelId": "Fixture", "outline": [[0, 0], [4, 0], [4, 4]],
                    "matterpakAlignmentVerified": True}
            alignment = Path(directory) / "legacy.json"
            h.server = SimpleNamespace(database=Path(directory) / "missing.sqlite",
                                       room=lambda *_: room,
                                       mesh_revision=lambda _: mesh,
                                       alignment_path=lambda *_: alignment)
            ref = {"model": "Fixture"}
            _, empty = h.room_lighting(ref)
            self.assertEqual(empty["status"], "missing")
            payload = json.loads(json.dumps({**ref, "revision": empty["revision"], "profile": PROFILE}))
            self.assertEqual(h.room_lighting(payload, save=True)[0], 200)
            self.assertEqual(h.room_lighting(ref)[1]["status"], "ready")
            self.assertEqual(h.room_lighting({**ref, "at": "2025-04-10T15:00:00Z"}, evaluate=True)[1]["status"], "ready")
            alignment.write_text("{}")
            self.assertEqual(h.room_lighting(ref)[1]["status"], "stale")
            self.assertEqual(h.room_lighting(payload, save=True)[0], 409)
            mesh[2] += 1
            self.assertEqual(h.room_lighting(ref, evaluate=True)[1]["status"], "unknown")

    def test_matterport_opening_maps_to_aligned_wall(self):
        from import_room import opening_candidates

        outline = [[0, 0], [4, 0], [4, 4], [0, 4]]
        opening = {"id": "test", "type": "opening", "width": 2, "height": 1,
                   "lowerElevation": 3, "relativeCenter": .5}
        edge = {"type": "wall", "vertices": [{"position": {"x": 4, "y": 0}},
                                             {"position": {"x": 0, "y": 0}}],
                "openings": [opening, {**opening, "type": "doorway"}]}
        candidates = opening_candidates({"boundary": {"edges": [edge]}}, outline, 2)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["outward"], [0, 0, -1])
        self.assertEqual(candidates[0]["corners"], [[3, 1, 0], [1, 1, 0], [1, 2, 0], [3, 2, 0]])
        from import_room import openings_on_outline
        elsewhere = {"boundary": {"edges": [{"type": "wall", "vertices": [
            {"position": {"x": 20, "y": 0}}, {"position": {"x": 24, "y": 0}}],
            "openings": [opening]}]}}
        matched = openings_on_outline([elsewhere, {"boundary": {"edges": [edge]}}], outline, 2)
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["source"], "Matterport opening test")
