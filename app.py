"""Serve the local scouting catalog and model-specific room exports."""
import argparse
import getpass
import json
import math
import tempfile
import mimetypes
import shutil
import sqlite3
import ssl
import subprocess
import sys
import zipfile
from threading import Lock
from weakref import WeakValueDictionary
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, unquote, urlsplit

import daylight

from catalog import build, coordinates_indexed, index_property_coordinates, scan_location, scan_property, search_page, source_mode
from fetch_matterpak import MAX_ARCHIVE_BYTES, MatterPakUnavailable, download_mesh, mesh_assets, stored_locally, unpack
from import_room import DEFAULT_ASSETS, OPENINGS_QUERY, opening_candidates, import_measured_room, import_rooms, read_model, valid_id
from location_map import locate_property
from model_provider import configured, next_turn

ROOT = Path(__file__).resolve().parent
MESH_CACHE = Path(os.environ.get("SCOUT_MESH_CACHE", ROOT / "mesh-cache"))
CAPTURE_CACHE = Path(os.environ.get("SCOUT_CAPTURE_CACHE", ROOT / "capture-cache"))


def matterport_configured():
    return all(os.getenv(name) for name in ("MATTERPORT_API_KEY", "MATTERPORT_API_TOKEN"))


def load_matterport_keychain():
    """Fill missing server credentials from the current user's macOS Keychain."""
    if sys.platform != "darwin" or matterport_configured():
        return
    account = getpass.getuser()
    for variable, service in (("MATTERPORT_API_KEY", "scout-matterport-key"),
                              ("MATTERPORT_API_TOKEN", "scout-matterport-token")):
        if os.getenv(variable):
            continue
        try:
            result = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-a", account, "-s", service, "-w"],
                capture_output=True, text=True, timeout=30, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0 and result.stdout.strip():
            os.environ[variable] = result.stdout.strip()


class ScoutServer(ThreadingHTTPServer):
    def __init__(self, address, database, assets):
        self.database = database
        self.assets = assets
        self.mesh_import_lock = Lock()
        self.mesh_imports = WeakValueDictionary()
        super().__init__(address, Handler)

    def mesh_root(self, model):
        cached = MESH_CACHE / model
        if (cached / "manifest.json").is_file():
            return cached.resolve()
        return (self.assets / "static" / "matterpak" / model).resolve()

    def mesh_lock(self, model):
        with self.mesh_import_lock:
            return self.mesh_imports.setdefault(model, Lock())

    def mesh_available(self, model):
        root = self.mesh_root(model)
        try:
            manifest = json.loads((root / "manifest.json").read_text())
            mesh_assets(root, manifest)
        except (OSError, ValueError, TypeError, KeyError):
            return False
        return True

    def mesh_revision(self, model):
        root = self.mesh_root(model)
        try:
            manifest = json.loads((root / "manifest.json").read_text())
            obj = (root / manifest["obj"]).resolve()
            if not obj.is_relative_to(root):
                return None
            info = obj.stat()
            if not stored_locally(info):
                return None
            return [obj.name, info.st_size, info.st_mtime_ns]
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def alignment_path(self, model, room_id):
        return self.assets / "alignment" / model / (f"room-{room_id}.json" if room_id else "legacy.json")

    def rooms(self, model):
        if not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
            return []
        paths = {}
        for base in (self.assets, ROOT):
            folder = base / "rooms"
            for path in sorted((folder / model).glob("*.json")):
                if valid_id(path.stem):
                    paths[path.stem] = path
        legacy_paths = (self.assets / "rooms" / f"{model}.json", self.assets / "room.json")
        rooms = []
        for path in (*paths.values(), *legacy_paths):
            try:
                with path.open(encoding="utf-8") as source:
                    data = json.load(source)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or data.get("modelId") != model or not data.get("outline"):
                continue
            if path == self.assets / "room.json":
                preset = ROOT / "presets" / f"{model}.json"
                if preset.is_file():
                    try:
                        data.update(json.loads(preset.read_text()))
                    except (OSError, ValueError):
                        pass
            if path == self.assets / "room.json" and any(room.get("roomId") for room in rooms):
                continue
            if not any(room.get("roomId") == data.get("roomId") for room in rooms):
                room_id = data.get("roomId")
                if room_id is None or valid_id(room_id):
                    try:
                        review = json.loads(self.alignment_path(model, room_id).read_text())
                        if review.get("meshRevision") == self.mesh_revision(model):
                            data.update(matterpakFloorHeight=review["floorHeight"],
                                        matterpakAlignmentVerified=review["accepted"],
                                        alignmentEvidence=review["note"])
                        else:
                            data.update(matterpakAlignmentVerified=False,
                                        alignmentEvidence="Mesh changed since the last review.")
                    except (OSError, ValueError, KeyError, AttributeError):
                        pass
                rooms.append(data)
        return [room for room in rooms
                if not re.fullmatch(r"void(?:\s+\d+)?", str(room.get("label", "")).strip(), re.I)]

    def room(self, model, room_id=None):
        return next((room for room in self.rooms(model)
                     if room_id is None or room.get("roomId") == room_id), None)


    def imported_rooms(self):
        models = set()
        for base in (self.assets, ROOT):
            folder = base / "rooms"
            if folder.is_dir():
                models.update(path.stem if path.is_file() else path.name for path in folder.iterdir())
        try:
            model = json.loads((self.assets / "room.json").read_text()).get("modelId")
            if isinstance(model, str):
                models.add(model)
        except (OSError, ValueError, AttributeError):
            pass
        return [room for model in sorted(models) for room in self.rooms(model)]

    def scan_readiness(self, model):
        rooms = self.rooms(model)
        result = {"roomCount": len(rooms), "meshAvailable": False, "alignedRoomCount": 0}
        if not rooms:
            return result
        if not self.mesh_available(model):
            return result
        result["meshAvailable"] = True
        result["alignedRoomCount"] = sum(room.get("matterpakAlignmentVerified") is True for room in rooms)
        return result

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "site"), **kwargs)

    def respond(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def room_lighting(self, data, save=False, evaluate=False):
        model, room_id = data.get("model"), data.get("room")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model) or (
                room_id is not None and not valid_id(room_id)):
            return self.respond(400, {"error": "Invalid room reference."})
        room = self.server.room(model, room_id)
        if room is None or room.get("roomId") != room_id:
            return self.respond(404, {"error": "Room not found."})
        alignment = self.server.alignment_path(model, room_id)
        path = alignment.with_name(alignment.stem + "-daylight.json")
        try:
            mesh = self.server.mesh_revision(model)
            revision = None
            if mesh and room.get("matterpakAlignmentVerified") is True:
                revision = {"mesh": mesh, "floor": room.get("matterpakFloorHeight", 0),
                            "up": room.get("matterpakUp"), "outline": room["outline"],
                            # A string preserves nanoseconds across JSON and JavaScript.
                            "alignment": str(alignment.stat().st_mtime_ns) if alignment.is_file() else None}
                revision["mesh"] = [*mesh[:2], str(mesh[2])]
            if save:
                if revision is None or data.get("revision") != revision:
                    return self.respond(409, {"error": "Reload the room and review mesh alignment before saving."})
                calibrated = daylight.profile(data.get("profile"))
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
                    temporary = Path(output.name)
                    try:
                        json.dump({"revision": revision, "profile": calibrated}, output, allow_nan=False)
                        output.close()
                        temporary.replace(path)
                    finally:
                        temporary.unlink(missing_ok=True)
                return self.respond(200, {"status": "ready", "revision": revision, "profile": calibrated})
            saved = json.loads(path.read_text()) if path.is_file() else {}
            calibrated = saved.get("profile")
            status = ("missing" if calibrated is None else "ready"
                      if revision is not None and saved.get("revision") == revision else "stale")
            if not evaluate:
                try:
                    site = scan_location(self.server.database, model)
                except sqlite3.Error:
                    site = None
                return self.respond(200, {"status": status, "revision": revision, "profile": calibrated,
                                          "locationDefaults": site})
            if status != "ready":
                return self.respond(200, {"status": "unknown", "reason": status + " daylight calibration", "frames": []})
            actors = data.get("actors", [])
            if not isinstance(actors, list) or len(actors) > 8:
                raise ValueError("Supply up to eight actor samples.")
            grid_path = path.with_name(path.stem + "-dsm.json")
            try:
                grid = json.loads(grid_path.read_text()) if grid_path.stat().st_size <= 16_000_000 else None
            except (OSError, ValueError):
                grid = None
            frames = daylight.study(calibrated, daylight.instants(data, calibrated["timeZone"]), [daylight.point(a) for a in actors], grid)
            return self.respond(200, {"status": "ready", "frames": frames})
        except (ValueError, OverflowError) as error:
            return self.respond(400, {"error": str(error)})
        except OSError:
            return self.respond(500, {"error": "Could not access local daylight data."})

    def do_PUT(self):
        if self.path != "/api/room-lighting":
            return self.respond(404, {"error": "Unknown endpoint."})
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.respond(403, {"error": "Open this action from the local app."})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 100_000 or self.headers.get_content_type() != "application/json":
                raise ValueError
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError
        except ValueError:
            return self.respond(400, {"error": "Invalid daylight profile request."})
        return self.room_lighting(payload, save=True)

    def do_POST(self):
        path = urlsplit(self.path)
        if path.path not in {"/api/upload-matterpak", "/api/daylight-study", "/api/window-candidates", "/api/agent-turn", "/api/import-room", "/api/import-measured-room", "/api/import-matterpak", "/api/room-alignment"}:
            return self.respond(404, {"error": "Unknown endpoint."})
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.respond(403, {"error": "Open this action from the local app."})
        if path.path == "/api/upload-matterpak":
            if self.headers.get_content_type() != "application/zip":
                return self.respond(415, {"error": "Select a MatterPak ZIP."})
            model = parse_qs(path.query).get("model", [""])[0]
            return self.import_matterpak({"model": model}, upload=True)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 100_000 or self.headers.get_content_type() != "application/json":
                raise ValueError
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError
            if path.path == "/api/window-candidates":
                return self.window_candidates(payload)
            if path.path == "/api/daylight-study":
                return self.room_lighting(payload, evaluate=True)
            if self.path == "/api/import-room":
                return self.import_room(payload)
            if self.path == "/api/import-measured-room":
                return self.import_measured_room(payload)
            if self.path == "/api/import-matterpak":
                return self.import_matterpak(payload)
            if self.path == "/api/room-alignment":
                return self.save_alignment(payload)
            if (not isinstance(payload.get("messages"), list)
                    or not isinstance(payload.get("tools"), list) or len(payload["messages"]) > 48):
                raise ValueError
        except (ValueError, TypeError):
            return self.respond(400, {"error": "Invalid agent request."})
        try:
            return self.respond(200, next_turn({"messages": payload["messages"], "tools": payload["tools"]}))
        except RuntimeError as error:
            return self.respond(503, {"error": str(error)})

    def window_candidates(self, data):
        model, room_id = data.get("model"), data.get("room")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model) or (
                room_id is not None and not valid_id(room_id)):
            return self.respond(400, {"error": "Invalid room reference."})
        room = self.server.room(model, room_id)
        if not room or room.get("roomId") != room_id:
            return self.respond(404, {"error": "Room not found."})
        if not room_id or not matterport_configured() or not room.get("matterpakAlignmentVerified"):
            return self.respond(200, {"candidates": []})
        try:
            result = read_model(model, interactive=False, query=OPENINGS_QUERY)
            rooms = ((result.get("data") or {}).get("model") or {}).get("rooms") or []
            vector = next((entry for entry in rooms if entry.get("id") == room_id), {})
            candidates = opening_candidates(vector, room["outline"], room.get("matterpakFloorHeight", 0))
        except (OSError, ValueError, TypeError, KeyError):
            candidates = []
        return self.respond(200, {"candidates": candidates})

    def import_room(self, payload):
        model = payload.get("model")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
            return self.respond(400, {"error": "Invalid Matterport model ID."})
        if not matterport_configured():
            return self.respond(503, {"error": "Configure the Matterport key and token in the server environment."})
        if self.server.rooms(model):
            return self.respond(200, {"imported": 0, "alreadyAvailable": True})
        try:
            result = read_model(model, interactive=False)
            imported, skipped = import_rooms(model, result, self.server.assets / "rooms")
        except (URLError, TimeoutError):
            return self.respond(502, {"error": "Matterport could not return geometry for this scan."})
        except (OSError, ValueError, TypeError, KeyError):
            return self.respond(422, {"error": "The scan could not be imported. Check its availability and room data."})
        if not imported and not self.server.rooms(model):
            return self.respond(422, {"error": "This scan has no importable closed room outlines.",
                                      "skipped": len(skipped)})
        return self.respond(200, {"imported": len(imported), "skipped": len(skipped)})

    def import_measured_room(self, payload):
        model, room_id = payload.get("model"), payload.get("room")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
            return self.respond(400, {"error": "Invalid Matterport model ID."})
        try:
            import_measured_room(model, room_id, payload.get("plan"), self.server.assets / "rooms")
        except FileExistsError:
            return self.respond(409, {"error": "That room ID already exists for this scan."})
        except ValueError as error:
            return self.respond(422, {"error": str(error)})
        except OSError:
            return self.respond(500, {"error": "Could not save the measured room."})
        return self.respond(201, {"room": room_id})

    def import_matterpak(self, payload, upload=False):
        model = payload.get("model")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
            return self.respond(400, {"error": "Invalid Matterport model ID."})
        if not self.server.rooms(model):
            return self.respond(404, {"error": "Import the room geometry first."})
        with self.server.mesh_lock(model):
            return self.prepare_matterpak(model, upload)

    def prepare_matterpak(self, model, upload):
        destination = MESH_CACHE / model
        if self.server.mesh_available(model):
            return self.respond(200, {"cached": True})
        try:
            if upload:
                try:
                    remaining = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    remaining = 0
                if not 0 < remaining <= MAX_ARCHIVE_BYTES:
                    return self.respond(413, {"error": "Select a ZIP up to 250 MB."})
                destination.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryFile() as archive:
                    while remaining:
                        chunk = self.rfile.read(min(remaining, 1024**2))
                        if not chunk:
                            raise ValueError("Incomplete upload.")
                        archive.write(chunk)
                        remaining -= len(chunk)
                    archive.seek(0)
                    unpack(archive, destination, replace_incomplete=True)
            else:
                if not matterport_configured():
                    return self.respond(503, {"error": "Configure the Matterport key and token in the server environment."})
                download_mesh(model, destination, os.environ["MATTERPORT_API_KEY"],
                              os.environ["MATTERPORT_API_TOKEN"], replace_incomplete=True)
        except MatterPakUnavailable as error:
            return self.respond(422, {"error": str(error)})
        except (URLError, TimeoutError) as error:
            if getattr(error, "code", None) in {401, 403}:
                return self.respond(403, {"error": "Matterport denied the request. Check the server credentials and access to this bundle."})
            return self.respond(502, {"error": "Matterport did not complete the download. Try again or upload the ZIP."})
        except (OSError, ValueError, zipfile.BadZipFile):
            return self.respond(422, {"error": "The MatterPak archive could not be imported. Check that it contains a usable mesh and fits within the size limits."})
        return self.respond(201, {"cached": False})

    def save_alignment(self, payload):
        model, room_id = payload.get("model"), payload.get("room")
        height, accepted = payload.get("floorHeight"), payload.get("accepted")
        if (not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model)
                or (room_id is not None and not valid_id(room_id))
                or type(height) not in (int, float) or not math.isfinite(height) or abs(height) > 200
                or type(accepted) is not bool):
            return self.respond(400, {"error": "Invalid room alignment settings."})
        room = self.server.room(model, room_id)
        if room is None or room.get("roomId") != room_id:
            return self.respond(404, {"error": "The selected room could not be found."})
        revision = self.server.mesh_revision(model)
        if revision is None:
            return self.respond(409, {"error": "The room needs a local MatterPak mesh."})
        path = self.server.alignment_path(model, room_id)
        review = {"meshRevision": revision, "floorHeight": height, "accepted": accepted,
                  "note": "Manually reviewed using the captured mesh and metric floor outline."
                  if accepted else "Mesh alignment review is pending."}
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                try:
                    json.dump(review, output)
                    output.flush()
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
        except OSError:
            return self.respond(500, {"error": "Could not save the room alignment."})
        return self.respond(200, review)

    def do_GET(self):
        url = urlsplit(self.path)
        params = parse_qs(url.query)
        if url.path == "/api/room-lighting":
            return self.room_lighting({key: params.get(key, [None])[0] for key in ("model", "room")})
        if url.path == "/api/room-import-status":
            return self.respond(200, {"configured": matterport_configured()})
        if url.path == "/api/agent-status":
            return self.respond(200, {"configured": configured()})
        if url.path == "/api/scan-property":
            model = params.get("model", [""])[0]
            if not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
                return self.respond(400, {"error": "Invalid scan ID."})
            try:
                return self.respond(200, {"property": scan_property(self.server.database, model)})
            except sqlite3.Error:
                return self.respond(503, {"error": "The property catalog is unavailable."})
        if url.path == "/api/location-map":
            value = params.get("property", [""])[0]
            if not re.fullmatch(r"[0-9]{1,15}", value):
                return self.respond(400, {"error": "Invalid property ID."})
            try:
                position = locate_property(self.server.database, int(value))
            except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
                return self.respond(503, {"error": "Address lookup is temporarily unavailable."})
            return self.respond(200, {"position": position})
        if url.path == "/api/locations":
            try:
                imported_models = None
                if params.get("imported", [""])[0] == "1":
                    imported_models = {room["modelId"] for room in self.server.imported_rooms()}
                page = search_page(self.server.database, params.get("q", [""])[0][:240],
                              offset=int(params.get("offset", ["0"])[0]),
                              limit=int(params.get("limit", ["12"])[0]),
                              city=params.get("city", [""])[0][:80],
                              category=params.get("category", [""])[0][:80],
                              linked_only=params.get("linked", [""])[0] == "1", imported_models=imported_models)
                rows = page["results"]
                mode = source_mode(self.server.database)
            except ValueError as error:
                return self.respond(400, {"error": str(error)})
            except sqlite3.Error:
                return self.respond(503, {"error": "The full CoStar catalog is unavailable."})
            models = {model for row in rows for model in row["models"]}
            readiness = {model: self.server.scan_readiness(model) for model in models}
            return self.respond(200, {"rows": rows, "mode": mode, "scanReadiness": readiness, "next_offset": page["next_offset"]})
        if url.path == "/api/imported-rooms":
            return self.respond(200, self.server.imported_rooms())
        if url.path == "/api/rooms":
            model = params.get("model", [""])[0]
            rooms = self.server.rooms(model)
            return self.respond(200, [{"id": room.get("roomId"), "label": room.get("label") or "Imported room",
                                      "floorId": room.get("floorId")} for room in rooms])
        if url.path == "/api/room":
            model = params.get("model", [""])[0]
            room = self.server.room(model, params.get("room", [None])[0])
            if room is None:
                return self.respond(404, {"error": "This scan has no imported room outline yet."})
            if (CAPTURE_CACHE / f"{model}.jpg").is_file() or (self.server.mesh_root(model) / "colorplan_000.jpg").is_file():
                room["capturePlan"] = f"/matterpak/{model}/colorplan_000.jpg"
            room["matterpakAvailable"] = self.server.mesh_available(model)
            room["matterpakDownloadConfigured"] = matterport_configured()
            return self.respond(200, room)
        if url.path.startswith("/matterpak/"):
            model, separator, resource = url.path.removeprefix("/matterpak/").partition("/")
            if not separator or not re.fullmatch(r"[A-Za-z0-9]{1,40}", model):
                return self.send_error(404)
            root = self.server.mesh_root(model)
            path = (root / unquote(resource)).resolve()
            cached_plan = CAPTURE_CACHE / f"{model}.jpg"
            if resource == "colorplan_000.jpg" and cached_plan.is_file():
                root, path = CAPTURE_CACHE.resolve(), cached_plan.resolve()
            if (not path.is_relative_to(root) or
                    path.suffix.lower() not in {".json", ".obj", ".mtl", ".png", ".jpg", ".jpeg"}
                    or not path.is_file()):
                return self.send_error(404)
            info = path.stat()
            if info.st_size and not stored_locally(info):
                return self.send_error(503, "Make this MatterPak file available offline")
            with path.open("rb") as file:
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(path.stat().st_size))
                self.end_headers()
                shutil.copyfileobj(file, self.wfile)
            return
        return super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=ROOT / "catalog.sqlite")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ASSETS)
    parser.add_argument("--kit", type=Path, default=Path(os.environ.get(
        "COSTAR_KIT", Path.home() / "Desktop/costar-hackathon/costar-hackathon-kit")))
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if sys.platform == "darwin" and "SSL_CERT_FILE" not in os.environ:
        system_ca = Path("/etc/ssl/cert.pem")
        if not ssl.get_default_verify_paths().cafile and system_ca.is_file():
            os.environ["SSL_CERT_FILE"] = str(system_ca)
    load_matterport_keychain()
    try:
        mode = source_mode(args.db)
    except sqlite3.OperationalError:
        mode = None
    property_file = args.kit / "data" / "commercial-property.jsonl"
    info = property_file.stat() if property_file.is_file() else None
    starter_only = info is None or bool(info.st_size and not stored_locally(info))
    if mode is None or (mode == "addresses" and not starter_only):
        print("Building the CoStar catalog…", flush=True)
        try:
            count = build(args.db, args.kit, starter_only=starter_only)
        except (OSError, ValueError) as error:
            print(f"Catalog unavailable: {error} Opening the room workspace anyway.", flush=True)
        else:
            coverage = "addresses and scan links" if starter_only else "full property records"
            print(f"Indexed {count} properties ({coverage}).", flush=True)
    if not starter_only:
        try:
            if not coordinates_indexed(args.db):
                index_property_coordinates(args.db, args.kit)
        except (OSError, sqlite3.Error, ValueError) as error:
            print(f"CoStar coordinates unavailable: {error}", flush=True)
    with ScoutServer(("127.0.0.1", args.port), args.db, args.assets) as server:
        print(f"Open http://127.0.0.1:{server.server_port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
