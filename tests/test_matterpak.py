import io
import json
import os
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from weakref import WeakValueDictionary
from unittest.mock import patch
from urllib.request import Request

import app
from fetch_matterpak import MatterPakSizeError, MatterPakUnavailable, download_mesh, get_download, mesh_assets, unpack


def bundle():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("capture.obj", "mtllib capture.mtl\nv 0 0 0\n")
        output.writestr("capture.mtl", "map_Kd capture.jpg\n")
        output.writestr("capture.jpg", b"texture")
    return archive.getvalue()


class MatterPakTests(unittest.TestCase):
    def test_prefers_zip_and_explains_missing_bundle(self):
        assets = [{"filename": "floor.png", "url": "https://example.com/floor.png"},
                  {"filename": "bundle.ZIP", "url": "https://example.com/signed?expires=1"}]

        def response(assets):
            return io.BytesIO(json.dumps({"data": {"model": {
                "bundle": {"availability": "unlocked", "assets": assets}}}}).encode())

        with patch("fetch_matterpak.urlopen", return_value=response(assets)):
            self.assertEqual(get_download("scan", "key", "token"), assets[1]["url"])
        with patch("fetch_matterpak.urlopen", return_value=response(assets[:1])):
            with self.assertRaisesRegex(MatterPakUnavailable, "bundle status: unlocked"):
                get_download("scan", "key", "token")

    def test_download_size_bound_applies_with_and_without_content_length(self):
        for headers in ({"Content-Length": "128"}, {}):
            with self.subTest(headers=headers), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / "scan"
                response = io.BytesIO(b"x" * 128)
                response.headers = headers
                with (patch("fetch_matterpak.MAX_ARCHIVE_BYTES", 100),
                      patch("fetch_matterpak.get_download", return_value="https://example.com/scan.zip"),
                      patch("fetch_matterpak.urlopen", return_value=response)):
                    with self.assertRaisesRegex(MatterPakSizeError, "ZIP exceeds"):
                        download_mesh("scan", destination, "key", "token")
                self.assertFalse(destination.exists())

    def test_range_download_skips_large_point_cloud(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zip_file:
            zip_file.writestr("capture.obj", "mtllib capture.mtl\nv 0 0 0\n")
            zip_file.writestr("unused.xyz", b" " * (512 * 1024))
            zip_file.writestr("capture.mtl", "map_Kd capture.jpg\n")
            zip_file.writestr("capture.jpg", b"texture")
        payload = archive.getvalue()
        transferred = []

        def range_response(request, timeout):
            low, high = request.get_header("Range").removeprefix("bytes=").split("-")
            start, end = (int(low), int(high)) if low else (len(payload) - int(high), len(payload) - 1)
            response = io.BytesIO(payload[start:end + 1])
            response.status = 206
            response.headers = {"Content-Range": f"bytes {start}-{end}/{len(payload)}"}
            transferred.append(end - start + 1)
            return response

        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "scan"
            with (patch("fetch_matterpak.MAX_ARCHIVE_BYTES", 160 * 1024),
                  patch("fetch_matterpak.RemoteZip.block_size", 4096),
                  patch("fetch_matterpak.get_download", return_value="https://example.com/scan.zip"),
                  patch("fetch_matterpak.urlopen", side_effect=range_response)):
                download_mesh("scan", destination, "key", "token")
            manifest = json.loads((destination / "manifest.json").read_text())
            self.assertEqual(mesh_assets(destination, manifest, require_textures=True).name, "capture.obj")
            self.assertFalse((destination / "unused.xyz").exists())
            self.assertLess(sum(transferred), len(payload) // 2)

    def test_invalid_replacement_preserves_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "scan"
            destination.mkdir()
            existing = destination / "manifest.json"
            existing.write_text("{}")
            with self.assertRaises(zipfile.BadZipFile):
                unpack(io.BytesIO(b"invalid zip"), destination, replace_incomplete=True)
            self.assertEqual(existing.read_text(), "{}")
            unpack(io.BytesIO(bundle()), destination, replace_incomplete=True)
            self.assertEqual(mesh_assets(destination, json.loads(existing.read_text()),
                                         require_textures=True).name, "capture.obj")

    def test_import_recovers_cache_and_reuses_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rooms = root / "rooms" / "testscan"
            rooms.mkdir(parents=True)
            (rooms / "testroom.json").write_text(json.dumps({
                "modelId": "testscan", "roomId": "testroom", "outline": [[0, 0], [1, 0], [1, 1]],
            }))
            cache = root / "cache"
            broken = cache / "testscan"
            broken.mkdir(parents=True)
            (broken / "manifest.json").write_text('{"obj":"missing.obj"}')
            server = object.__new__(app.ScoutServer)
            server.assets = root
            server.mesh_import_lock = Lock()
            server.mesh_imports = WeakValueDictionary()

            def request(model):
                handler = object.__new__(app.Handler)
                handler.server = server
                handler.respond = lambda status, value: (status, value)
                return handler.import_matterpak({"model": model})

            def matterport(url, timeout):
                if isinstance(url, Request) and url.full_url.startswith("https://api.matterport.com/"):
                    return io.BytesIO(json.dumps({"data": {"model": {"bundle": {
                        "availability": "unlocked",
                        "assets": [{"url": "https://example.com/mesh.zip"}],
                    }}}}).encode())
                response = io.BytesIO(bundle())
                response.headers = {}
                return response

            with (patch.object(app, "MESH_CACHE", cache),
                  patch.dict(os.environ, MATTERPORT_API_KEY="key", MATTERPORT_API_TOKEN="token"),
                  patch("fetch_matterpak.urlopen", side_effect=matterport) as remote):
                self.assertFalse(server.mesh_available("testscan"))
                with ThreadPoolExecutor(max_workers=2) as executor:
                    requests = [executor.submit(request, "testscan") for _ in range(2)]
                    self.assertEqual(sorted(item.result()[0] for item in requests), [200, 201])
                self.assertEqual(remote.call_count, 2)
                self.assertTrue(server.mesh_available("testscan"))
                self.assertEqual(request("unknown")[0], 404)
