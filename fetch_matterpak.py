"""Recover an existing Matterport mesh into a separate, local asset directory."""
import argparse
import base64
import getpass
import io
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

MAX_ARCHIVE_BYTES = 1024**3
MAX_EXPANDED_BYTES = 2 * 1024**3


class MatterPakSizeError(ValueError):
    """The archive or extracted rendering assets exceed a size limit."""


class MatterPakUnavailable(ValueError):
    """The API did not provide a downloadable bundle for this model."""

GRAPH = "https://api.matterport.com/api/models/graph"
QUERY = """query Mesh($id: ID!) {
  model(id: $id) {
    bundle(id: "mp:matterpak") { availability assets { filename status url } }
    assets { resources(format: "matterpak") { filename status url } }
  }
}"""


def stored_locally(info):
    """A cloud placeholder has a size but no allocated blocks.

    Windows stat results omit st_blocks for an ordinary local file.
    """
    blocks = getattr(info, "st_blocks", None)
    return bool(info.st_size) and blocks != 0


def get_download(model, key, token):
    auth = base64.b64encode(f"{key}:{token}".encode()).decode()
    request = Request(GRAPH, json.dumps({"query": QUERY, "variables": {"id": model}}).encode(),
                      {"Authorization": f"Basic {auth}", "Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    data = (result.get("data") or {}).get("model") or {}
    if result.get("errors") and not data:
        raise MatterPakUnavailable("Matterport could not return this model. Check the server credentials and model access.")
    bundle = data.get("bundle") or {}
    assets = (bundle.get("assets") or []) + ((data.get("assets") or {}).get("resources") or [])
    links = [asset for asset in assets if asset and isinstance(asset.get("url"), str)
             and urlsplit(asset["url"]).scheme == "https"]
    for asset in links:
        url = asset["url"]
        if any(str(name).lower().endswith(".zip") for name in
               (asset.get("filename"), urlsplit(url).path)):
            return url
    # The bundle API can return an opaque signed URL without a filename.
    for asset in links:
        if asset in (bundle.get("assets") or []) and not asset.get("filename"):
            return asset["url"]
    availability = bundle.get("availability", "unknown")
    raise MatterPakUnavailable(
        f"Matterport did not provide a MatterPak ZIP (bundle status: {availability}). "
        "Check that the bundle is ready and accessible to the server account, or upload its ZIP."
    )


def mesh_assets(root, manifest, *, require_textures=False):
    """Resolve and check the files required to render a textured scan."""
    root = root.resolve()

    def require_file(name, base, suffixes):
        path = (base / name).resolve()
        if not path.is_relative_to(root) or path.suffix.lower() not in suffixes or not path.is_file():
            raise ValueError("A required MatterPak asset is missing or invalid.")
        info = path.stat()
        if not stored_locally(info):
            raise ValueError("A required MatterPak asset is empty or offline.")
        return path

    mesh = require_file(manifest["obj"], root, {".obj"})
    texture_count = 0
    if manifest.get("mtl"):
        material = require_file(manifest["mtl"], root, {".mtl"})
        with material.open(errors="replace") as source:
            for line in source:
                fields = line.strip().split(maxsplit=1)
                if fields and fields[0].lower() == "map_kd":
                    if len(fields) != 2:
                        raise ValueError("A MatterPak texture reference is empty.")
                    require_file(fields[1], material.parent, {".jpg", ".jpeg", ".png"})
                    texture_count += 1
    if require_textures and not texture_count:
        raise ValueError("The MatterPak contains no diffuse textures.")
    return mesh


def unpack(archive, destination, *, replace_incomplete=False):
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
            if expanded_size > MAX_EXPANDED_BYTES:
                raise MatterPakSizeError("The MatterPak rendering assets exceed the 2 GiB extraction limit.")
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
        if not destination.exists():
            staging.rename(destination)
            return
        if not replace_incomplete:
            raise FileExistsError(f"Already imported: {destination}")
        backup = Path(temp) / "previous"
        destination.rename(backup)
        try:
            staging.rename(destination)
        except OSError:
            backup.rename(destination)
            raise


class RemoteZip(io.RawIOBase):
    """Read a ZIP using byte ranges so extraction can skip unused files."""

    block_size = 8 * 1024**2

    def __init__(self, url, size, tail_start, tail):
        super().__init__()
        self.url = url
        self.size = size
        self.position = 0
        self.tail_start = tail_start
        self.tail = tail
        self.block_start = 0
        self.block = b""
        self.downloaded = len(tail)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        if base + offset < 0:
            raise OSError("Invalid ZIP offset.")
        self.position = base + offset
        return self.position

    def readinto(self, buffer):
        if self.position >= self.size or not buffer:
            return 0
        if self.position >= self.tail_start:
            start, data = self.tail_start, self.tail
        else:
            if not self.block_start <= self.position < self.block_start + len(self.block):
                self.block_start = self.position
                end = min(self.tail_start, self.position + self.block_size) - 1
                length = end - self.position + 1
                if self.downloaded + length > MAX_ARCHIVE_BYTES:
                    raise MatterPakSizeError("The MatterPak needs more than 1 GiB of download data to render.")
                request = Request(self.url, headers={"Range": f"bytes={self.position}-{end}"})
                with urlopen(request, timeout=60) as response:
                    if (response.status != 206 or
                            response.headers.get("Content-Range") != f"bytes {self.position}-{end}/{self.size}"):
                        raise zipfile.BadZipFile("The signed download returned an unexpected byte range.")
                    self.block = response.read(length + 1)
                if len(self.block) != length:
                    raise zipfile.BadZipFile("The signed download returned an incomplete byte range.")
                self.downloaded += length
            start, data = self.block_start, self.block
        offset = self.position - start
        count = min(len(buffer), len(data) - offset)
        buffer[:count] = data[offset:offset + count]
        self.position += count
        return count


def download_mesh(model, destination, key, token, *, replace_incomplete=False):
    url = get_download(model, key.strip(), token.strip())
    if urlsplit(url).scheme != "https":
        raise ValueError("Matterport did not return a secure download URL.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    tail_size = 128 * 1024
    request = Request(url, headers={"Range": f"bytes=-{tail_size}"})
    with urlopen(request, timeout=60) as response:
        if getattr(response, "status", 200) == 206:
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
            if not match:
                raise zipfile.BadZipFile("Matterport did not identify the ZIP byte range.")
            start, end, size = map(int, match.groups())
            if end != size - 1 or start != max(0, size - tail_size):
                raise zipfile.BadZipFile("Matterport returned an unexpected ZIP tail range.")
            tail = response.read(tail_size + 1)
            if len(tail) != size - start:
                raise zipfile.BadZipFile("Matterport returned an incomplete ZIP directory.")
            with io.BufferedReader(RemoteZip(url, size, start, tail)) as archive:
                unpack(archive, destination, replace_incomplete=replace_incomplete)
            return
        content_length = response.headers.get("Content-Length")
        if content_length and content_length.isdecimal() and int(content_length) > MAX_ARCHIVE_BYTES:
            raise MatterPakSizeError("The MatterPak ZIP exceeds the 1 GiB download limit.")
        with tempfile.TemporaryFile() as archive:
            size = 0
            while chunk := response.read(1024**2):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise MatterPakSizeError("The MatterPak ZIP exceeds the 1 GiB download limit.")
                archive.write(chunk)
            archive.seek(0)
            unpack(archive, destination, replace_incomplete=replace_incomplete)


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
