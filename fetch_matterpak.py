"""Recover an existing Matterport mesh into a separate, local asset directory."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import zipfile

GRAPH = "https://api.matterport.com/api/models/graph"
QUERY = """query Mesh($id: ID!) {
  model(id: $id) {
    bundle(id: "mp:matterpak") { availability assets { filename status url } }
    assets { resources(format: "matterpak") { filename status url } }
  }
}"""


def get_download(model, key, token):
    auth = base64.b64encode(f"{key}:{token}".encode()).decode()
    request = Request(GRAPH, json.dumps({"query": QUERY, "variables": {"id": model}}).encode(),
                      {"Authorization": f"Basic {auth}", "Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    data = (result.get("data") or {}).get("model") or {}
    bundle = data.get("bundle") or {}
    assets = ((data.get("assets") or {}).get("resources") or []) + (bundle.get("assets") or [])
    for asset in assets:
        if asset and asset.get("url"):
            return asset["url"]
    raise ValueError(f"No MatterPak download link. Bundle status: {bundle.get('availability', 'unknown')}.")


def mesh_assets(root, manifest):
    """Resolve and check the files required to render a textured scan."""
    root = root.resolve()

    def require_file(name, base, suffixes):
        path = (base / name).resolve()
        if not path.is_relative_to(root) or path.suffix.lower() not in suffixes or not path.is_file():
            raise ValueError("A required MatterPak asset is missing or invalid.")
        info = path.stat()
        if not info.st_size or not info.st_blocks:
            raise ValueError("A required MatterPak asset is empty or offline.")
        return path

    mesh = require_file(manifest["obj"], root, {".obj"})
    if manifest.get("mtl"):
        material = require_file(manifest["mtl"], root, {".mtl"})
        with material.open(errors="replace") as source:
            for line in source:
                fields = line.strip().split(maxsplit=1)
                if fields and fields[0].lower() == "map_kd":
                    if len(fields) != 2:
                        raise ValueError("A MatterPak texture reference is empty.")
                    require_file(fields[1], material.parent, {".jpg", ".jpeg", ".png"})
    return mesh


def unpack(archive, destination):
    suffixes = {".obj", ".mtl", ".jpg", ".jpeg", ".png"}
    with zipfile.ZipFile(archive) as bundle, tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        staging = (Path(temp) / "mesh").resolve()
        expanded_size = 0
        for entry in bundle.infolist():
            relative = PurePosixPath(entry.filename)
            if entry.is_dir() or relative.suffix.lower() not in suffixes:
                continue
            if relative.is_absolute() or ".." in relative.parts or "\\" in entry.filename:
                raise ValueError("Unexpected archive path.")
            expanded_size += entry.file_size
            if expanded_size > 1024**3:
                raise ValueError("Expanded MatterPak exceeds 1 GB.")
            target = staging.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
        meshes = list(staging.rglob("*.obj"))
        if len(meshes) != 1:
            raise ValueError("Expected one MatterPak OBJ.")
        mesh, = meshes
        with mesh.open(errors="replace") as source:
            materials = next((line.split(maxsplit=1)[1].strip()
                              for line in source if line.startswith("mtllib ")), None)
        material_path = (mesh.parent / materials).resolve() if materials else None
        if material_path and (not material_path.is_relative_to(staging) or not material_path.is_file()):
            raise ValueError("The mesh's material file is missing.")
        manifest = {
            "obj": mesh.relative_to(staging).as_posix(),
            "mtl": material_path.relative_to(staging).as_posix() if material_path else None,
        }
        mesh_assets(staging, manifest)
        (staging / "manifest.json").write_text(json.dumps(manifest))
        if destination.exists():
            raise FileExistsError(f"Already imported: {destination}")
        staging.rename(destination)


def download_mesh(model, destination, key, token):
    url = get_download(model, key.strip(), token.strip())
    if urlsplit(url).scheme != "https":
        raise ValueError("Matterport did not return a secure download URL.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile() as archive, urlopen(url, timeout=60) as response:
        shutil.copyfileobj(response, archive)
        archive.seek(0)
        unpack(archive, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model")
    parser.add_argument("--zip", type=Path)
    parser.add_argument("--cache", type=Path, default=Path(os.getenv("SCOUT_MESH_CACHE", Path(__file__).with_name("mesh-cache"))))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9]{1,40}", args.model):
        parser.error("Invalid model ID.")
    destination = args.cache.resolve() / args.model
    if destination.exists():
        parser.error(f"Already imported: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        if args.zip:
            unpack(args.zip, destination)
        else:
            key = os.environ.get("MATTERPORT_API_KEY") or getpass.getpass("Matterport API key: ")
            token = os.environ.get("MATTERPORT_API_TOKEN") or getpass.getpass("Matterport API token: ")
            download_mesh(args.model, destination, key, token)
    except URLError as error:
        parser.exit(1, f"Matterport request failed ({getattr(error, 'code', 'connection error')}).\n")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Import failed: {error}\n")
    print(f"Ready: {destination}")


if __name__ == "__main__":
    main()
