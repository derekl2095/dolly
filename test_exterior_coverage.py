import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from exterior_coverage import (
    closest_capture, coverage_queries, facade_body, newest_oblique_collection,
    request_coverage, request_image,
)


class CoverageTests(unittest.TestCase):
    def test_point_and_closed_block_use_longitude_first(self):
        query = coverage_queries(-95.4, 29.7, [-95.5, 29.6, -95.3, 29.8])
        self.assertEqual(query["oriented"]["wkt"], "POINT(-95.4 29.7)")
        self.assertEqual(query["dsm"]["wkt"],
                         "POLYGON((-95.5 29.6, -95.3 29.6, -95.3 29.8, -95.5 29.8, -95.5 29.6))")
        self.assertEqual(query["dsm"]["srid"], 4326)

    def test_rejects_block_away_from_property(self):
        with self.assertRaises(ValueError):
            coverage_queries(-95.4, 29.7, [10, 11, 12, 13])

    @patch("exterior_coverage.build_opener")
    def test_http_error_output_does_not_disclose_key(self, opener):
        opener.return_value.open.side_effect = HTTPError(
            "https://api.vexcelgroup.com/v2/oriented/collections", 403, "Forbidden", {}, None)
        result = request_coverage("oriented", {"srid": 4326, "wkt": "POINT(-95.4 29.7)"}, "fixture-key")
        sent = opener.return_value.open.call_args.args[0]
        headers = {name.lower(): value for name, value in sent.header_items()}
        self.assertEqual(headers.get("x-api-key"), "fixture-key")
        self.assertNotIn("fixture-key", sent.full_url)
        self.assertNotIn("token=", sent.full_url)
        self.assertEqual(result["http"], 403)
        self.assertNotIn("fixture-key", str(result))

    def test_newest_collection_keeps_its_own_oblique_directions(self):
        chosen = newest_oblique_collection({"features": [
            {"properties": {"product-type": "nadir", "collection": "newer-nadir",
                            "last-capture-date": "2026-06-01T12:00:00", "layer": "urban"}},
            {"properties": {"product-type": "oblique-north", "collection": "older",
                            "last-capture-date": "2024-01-01T16:00:00", "layer": "urban"}},
            {"properties": {"product-type": "oblique-east", "collection": "us-tx-houston-2026",
                            "last-capture-date": "2026-01-02T18:43:55", "layer": "urban"}},
            {"properties": {"product-type": "oblique-north", "collection": "us-tx-houston-2026",
                            "last-capture-date": "2026-01-02T18:00:00", "layer": "urban"}},
        ]})
        self.assertEqual(chosen["collection"], "us-tx-houston-2026")
        self.assertEqual(chosen["directions"], ["oblique-north", "oblique-east"])

    def test_closest_capture_uses_clock_time_across_midnight(self):
        records = [
            {"image-name": "morning", "capture-date": "2026-01-02T07:10:00", "hour": 7 + 10 / 60,
             "product-type": "oblique-north", "collection": "c", "layer": "urban"},
            {"image-name": "afternoon", "capture-date": "2026-01-02T16:30:00", "hour": 16.5,
             "product-type": "oblique-north", "collection": "c", "layer": "urban"},
            {"image-name": "late", "capture-date": "2024-01-01T23:30:00", "hour": 23.5,
             "product-type": "oblique-east", "collection": "c", "layer": "urban"},
            {"image-name": "mid", "capture-date": "2024-01-01T10:00:00", "hour": 10,
             "product-type": "oblique-east", "collection": "c", "layer": "urban"},
        ]
        morning = closest_capture(records[:2], 7)
        self.assertEqual(morning["image-name"], "morning")
        self.assertAlmostEqual(morning["hours-from-request"], 10 / 60)
        late = closest_capture(records[2:], 1)
        self.assertEqual(late["image-name"], "late")
        self.assertAlmostEqual(late["hours-from-request"], 1.5)

    @patch("exterior_coverage.build_opener")
    def test_facade_request_keeps_the_key_out_of_the_body(self, opener):
        opener.return_value.open.side_effect = HTTPError(
            "https://api.vexcelgroup.com/v2/oriented/extract", 403, "Forbidden", {}, None)
        body = facade_body({
            "image-name": "sample-image", "product-type": "oblique-north", "layer": "urban",
        }, -95.4, 29.7)
        result = request_image("oriented/extract", body, "fixture-key")
        sent = opener.return_value.open.call_args.args[0]
        headers = {name.lower(): value for name, value in sent.header_items()}
        self.assertEqual(headers.get("x-api-key"), "fixture-key")
        self.assertNotIn("fixture-key", sent.data.decode())
        self.assertNotIn("token", sent.data.decode())
        self.assertEqual(result["http"], 403)
