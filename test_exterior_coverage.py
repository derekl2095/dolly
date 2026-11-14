import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from exterior_coverage import coverage_queries, request_coverage


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
    def test_http_error_output_does_not_disclose_token_url(self, opener):
        opener.return_value.open.side_effect = HTTPError(
            "https://api.vexcelgroup.com/?token=fixture", 403, "Forbidden", {}, None)
        result = request_coverage("oriented", {"srid": 4326}, "fixture")
        self.assertEqual(result["http"], 403)
        self.assertNotIn("fixture", str(result))
