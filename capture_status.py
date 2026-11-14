"""Inspect local evidence and optionally probe Matterport for a candidate scan."""
import argparse
import json
from pathlib import Path
from urllib.error import URLError

from fetch_matterpak import get_download, mesh_assets
from import_room import outline, read_model, valid_id


def local_status(model, assets, cache):
    rooms = []
    for path in sorted((assets / "rooms" / model).glob("*.json")) + [
        assets / "rooms" / f"{model}.json", assets / "room.json"
    ]:
        if path.is_file():
            record = json.loads(path.read_text())
            if record.get("modelId") == model and record.get("outline"):
                rooms.append({"room_id": record.get("roomId"), "source": record.get("geometrySource")})
    root = cache / model
    try:
        mesh = mesh_assets(root, json.loads((root / "manifest.json").read_text()),
                           require_textures=True)
        texture_status = "available"
    except FileNotFoundError:
        mesh = None
        texture_status = "not cached"
    except (ValueError, OSError, KeyError, TypeError):
        mesh = None
        texture_status = "incomplete"
    return {"model_id": model, "rooms": rooms, "textured_mesh": texture_status,
            "mesh_file": mesh.name if mesh else None}


def probe(model, key, token):
    """Report geometry and bundle availability independently. Return no URLs."""
    result = {"model_id": model, "closed_rooms": [], "geometry": "unknown", "bundle": "unknown"}
    try:
        payload = read_model(model, interactive=False)
        record = (payload.get("data") or {}).get("model")
        if record:
            floors = {floor["id"]: floor for floor in record.get("floors") or []}
            for room in record.get("rooms") or []:
                try:
                    outline(room, floors[room["floor"]["id"]])
                except (ValueError, KeyError, TypeError):
                    continue
                result["closed_rooms"].append(room["id"])
            result["geometry"] = "closed boundaries" if result["closed_rooms"] else "no closed boundaries"
        else:
            result["geometry"] = "model unavailable"
    except (URLError, ValueError):
        result["geometry"] = "request failed"
    try:
        get_download(model, key, token)
        result["bundle"] = "download link available"
    except URLError:
        result["bundle"] = "request failed"
    except ValueError:
        result["bundle"] = "no download link"
    return result


def main():
    import os

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", nargs="+")
    parser.add_argument("--assets", type=Path, default=Path("local-assets"))
    parser.add_argument("--cache", type=Path, default=Path(os.getenv("SCOUT_MESH_CACHE", "mesh-cache")))
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if any(not valid_id(model) or not model.isalnum() or len(model) > 40 for model in args.model):
        parser.error("Invalid Matterport model ID")
    key = os.getenv("MATTERPORT_API_KEY", "").strip()
    token = os.getenv("MATTERPORT_API_TOKEN", "").strip()
    if args.probe and not (key and token):
        parser.error("Configure MATTERPORT_API_KEY and MATTERPORT_API_TOKEN locally.")
    for model in args.model:
        status = local_status(model, args.assets, args.cache)
        if args.probe:
            status["remote"] = probe(model, key, token)
        print(json.dumps(status))


if __name__ == "__main__":
    main()
