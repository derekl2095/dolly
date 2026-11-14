import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from catalog import build, inventory, search, search_page
from capture_status import local_status, probe
from fetch_matterpak import stored_locally


class CatalogTests(unittest.TestCase):
    def test_catalog_preserves_links_and_pages_leads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = root / "index.sqlite"
            (root / "data").mkdir()
            (root / "commercial-properties.csv").write_text(
                "PropertyId,Address,City,State,MatterportModelId\n"
                "10,1 Canal St,Houston,TX,ScanA\n"
                "10,1 Canal St,Houston,TX,ScanB\n"
                "20,2 Canal St,Houston,TX,\n"
            )
            address = {"streetNumber": 1, "streetName": "Canal", "streetType": "St",
                       "city": "Houston", "state": "TX"}
            linked = {"id": 10, "primaryAddress": address, "propertyType": 11,
                      "notes": [{"value": "Apartment with tall ceilings"}],
                      "attachments": [{"videoKey": "ScanA", "caption": "Loft"}]}
            unlinked = {"id": 30, "primaryAddress": address, "propertyType": 11}
            (root / "data/commercial-property.jsonl").write_text(
                "\n".join(map(json.dumps, [linked, linked, unlinked]))
            )
            self.assertEqual(build(db, root), 3)
            first = search_page(db, city="houston", limit=1)
            self.assertEqual(first["next_offset"], 1)
            self.assertEqual(first["results"][0]["models"], {"ScanA": "Loft", "ScanB": None})
            second = search_page(db, city="Houston", limit=2, offset=first["next_offset"])
            self.assertEqual([row["property_id"] for row in second["results"]], [20, 30])
            self.assertIsNone(second["next_offset"])
            self.assertEqual(second["results"][0]["evidence"], "2 Canal St")
            self.assertEqual(inventory(db)["without_scans"], 2)
            self.assertEqual(len(search(db, "ceilings", category="apartment")), 1)
            self.assertEqual(len(search_page(db, linked_only=True)["results"]), 1)
            self.assertEqual(search_page(db, imported_models=set())["results"], [])
            filtered = search_page(db, imported_models={"ScanA"})
            self.assertEqual([row["models"] for row in filtered["results"]], [{"ScanA": "Loft"}])


    def test_shared_outline_snapshot_distinguishes_remote_ready_and_empty_scans(self):
        from app import ScoutServer, load_outline_index

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "outlines.csv"
            index.write_text("model_id,status,closed_rooms\n"
                             "Remote,closed,3\n"
                             "Empty,no-floor-edges,0\n"
                             "Unavailable,request-failed,0\n"
                             "Bad,closed,0\n")
            server = object.__new__(ScoutServer)
            server.assets = root
            server.outline_index = load_outline_index(index)
            self.assertEqual(server.scan_readiness("Remote")["remoteRoomCount"], 3)
            self.assertEqual(server.scan_readiness("Remote")["roomCount"], 0)
            self.assertEqual(server.scan_readiness("Empty")["remoteOutlineStatus"], "no-floor-edges")
            self.assertEqual(server.scan_readiness("Bad")["remoteOutlineStatus"], "unchecked")


class CaptureTests(unittest.TestCase):
    def test_local_status_requires_diffuse_texture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "ScanA"
            mesh.mkdir()
            (mesh / "manifest.json").write_text('{"obj":"room.obj","mtl":"room.mtl"}')
            (mesh / "room.obj").write_text("mtllib room.mtl\n")
            (mesh / "room.mtl").write_text("newmtl room\n")
            self.assertEqual(local_status("ScanA", root, root)["textured_mesh"], "incomplete")
            (mesh / "room.mtl").write_text("map_Kd room.jpg\n")
            (mesh / "room.jpg").write_bytes(b"texture fixture")
            self.assertEqual(local_status("ScanA", root, root)["textured_mesh"], "available")

    @patch("capture_status.get_download", return_value="https://example.test/private")
    @patch("capture_status.read_model", return_value={"data": {"model": {"floors": [], "rooms": []}}})
    def test_probe_reports_only_evidence(self, _read_model, _get_download):
        info = probe("ScanA", "fixture", "fixture")
        self.assertEqual(info["geometry"], "no closed boundaries")
        self.assertEqual(info["bundle"], "download link available")
        self.assertNotIn("https", json.dumps(info))


class StoredLocallyTests(unittest.TestCase):
    def test_windows_stat_without_blocks_counts_as_local(self):
        self.assertTrue(stored_locally(SimpleNamespace(st_size=10)))

    def test_cloud_placeholder_and_empty_files_do_not(self):
        self.assertFalse(stored_locally(SimpleNamespace(st_size=10, st_blocks=0)))
        self.assertFalse(stored_locally(SimpleNamespace(st_size=0, st_blocks=4)))
        self.assertTrue(stored_locally(SimpleNamespace(st_size=10, st_blocks=4)))


class OutlineTopologyTests(unittest.TestCase):
    def test_dangling_edges_keep_the_existing_cycle(self):
        from import_room import outline

        coords = {"a": (0, 0), "b": (2, 0), "c": (2, 2), "d": (0, 2), "e": (3, 0)}
        segments = ["be", "ab", "bc", "cd", "da"]
        floor = {
            "vertices": [{"id": key, "position": {"x": x, "y": y}} for key, (x, y) in coords.items()],
            "edges": [{"id": segment, "vertices": [{"id": key} for key in segment]} for segment in segments],
        }
        room = {"boundary": {"edges": [{"id": segment} for segment in segments]}}
        self.assertEqual(set(outline(room, floor)), {(0, 0), (2, 0), (2, 2), (0, 2)})
        room["boundary"]["edges"].pop()
        with self.assertRaisesRegex(ValueError, "closed outline"):
            outline(room, floor)


if __name__ == "__main__":
    unittest.main()
