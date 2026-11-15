"""Import metric room outlines for a Matterport model or a saved API response."""
import argparse
import base64
import getpass
import json
import math
import os
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

DEFAULT_ASSETS = Path(__file__).resolve().parent / "local-assets"
QUERY = """query Room($id: ID!) { model(id: $id) {
  id
  floors { id vertices { id position { x y } } edges { id vertices { id } } }
  rooms { id floor { id } classifications { label confidence } boundary { edges { id } } dimensions(units: metric) { height } }
} }"""


OPENINGS_QUERY = """query Openings($id: ID!) { model(id: $id) {
  id rooms { id boundary { edges { type
    vertices { position { x y } }
    openings { id type width height lowerElevation relativeCenter }
  } } }
} }"""


# Imported outlines store Model API floor (x, y) directly as Scout (x, z).
# Sample that directed axis in the Model API, independent of Showcase rotation.
HEADING_QUERY = """query Heading($id: ID!) { model(id: $id) {
  geocoordinates {
    origin: geoLocationOf(modelLocation: {x: 0, y: 0, z: 0}) { lat long }
    plusZ: geoLocationOf(modelLocation: {x: 0, y: 10, z: 0}) { lat long }
  }
} }"""


def model_heading(payload):
    """Calculate the true bearing of Scout's +Z from Matterport's two geo samples."""
    try:
        geo = payload["data"]["model"]["geocoordinates"]
        lat1, lon1, lat2, lon2 = (
            float(geo[point][axis]) for point in ("origin", "plusZ") for axis in ("lat", "long")
        )
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not all(-90 < lat < 90 for lat in (lat1, lat2)) or not all(-180 <= lon <= 180 for lon in (lon1, lon2)):
        return None
    a, b, delta = map(math.radians, (lat1, lat2, lon2 - lon1))
    east = math.sin(delta) * math.cos(b)
    north = math.cos(a) * math.sin(b) - math.sin(a) * math.cos(b) * math.cos(delta)
    separation = 2 * 6371008.8 * math.asin(min(1, math.hypot(
        math.sin((b - a) / 2), math.sqrt(math.cos(a) * math.cos(b)) * math.sin(delta / 2)
    )))
    # Reject coincident points or a transform that fails to preserve this meter-scale baseline.
    if not 5 <= separation <= 15:
        return None
    return round(math.degrees(math.atan2(east, north)) % 360, 2) % 360


def opening_candidates(room, outline_points, floor_height):
    winding = sum(a[0]*b[1] - a[1]*b[0]
                  for a, b in zip(outline_points, outline_points[1:] + outline_points[:1]))
    candidates = []
    for edge in (room.get("boundary") or {}).get("edges") or []:
        if edge.get("type") != "wall":
            continue
        try:
            a, b = [(v["position"]["x"], v["position"]["y"]) for v in edge["vertices"]]
            dx, dz = b[0]-a[0], b[1]-a[1]
            length = math.hypot(dx, dz)
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(length) or length < .35:
            continue
        for start, end in zip(outline_points, outline_points[1:] + outline_points[:1]):
            if math.dist(a, start) < .05 and math.dist(b, end) < .05:
                sign = 1
                break
            if math.dist(b, start) < .05 and math.dist(a, end) < .05:
                sign = -1
                break
        else:
            continue
        normal = [sign * math.copysign(1, winding)*dz/length, 0,
                  -sign * math.copysign(1, winding)*dx/length]
        for opening in edge.get("openings") or []:
            try:
                width, height, base, center = (opening[key] for key in
                                              ("width", "height", "lowerElevation", "relativeCenter"))
                sill = base-floor_height
                low, high = center-width/(2*length), center+width/(2*length)
                if (opening["type"] != "opening" or not .35 <= width <= length or not .35 <= height <= 12
                        or not .25 <= sill <= 12 or not 0 <= low < high <= 1):
                    continue
                corners = [[a[0]+dx*t, y, a[1]+dz*t] for t,y in
                           ((low,sill),(high,sill),(high,sill+height),(low,sill+height))]
                candidates.append({"corners": corners, "outward": normal,
                                   "source": "Matterport opening " + str(opening["id"])})
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
    return candidates[:32]


def openings_on_outline(rooms, outline_points, floor_height):
    """Keep Matterport openings whose wall matches this floor outline."""
    found = []
    for room in rooms or []:
        found.extend(opening_candidates(room, outline_points, floor_height))
    return found[:32]


def outline(room, floor):
    vertices = {v["id"]: (v["position"]["x"], v["position"]["y"])
                for v in floor["vertices"] if v.get("position")}
    edges = {e["id"]: [v["id"] for v in e["vertices"]] for e in floor["edges"]}
    segments = [edges.get(e["id"], []) for e in (room.get("boundary") or {}).get("edges", [])]
    if len(segments) < 3 or any(len(e) != 2 for e in segments):
        raise ValueError("Matterport returned an incomplete boundary.")
    neighbors = {}
    unique = set()
    for start, end in segments:
        edge = frozenset((start, end))
        if len(edge) != 2 or edge in unique:
            raise ValueError("Room boundary contains duplicate or degenerate edges.")
        unique.add(edge)
        neighbors.setdefault(start, set()).add(end)
        neighbors.setdefault(end, set()).add(start)

    # Strip dead-end branches. Every retained segment must already exist in
    # Matterport's graph, and the remainder must be one unambiguous loop.
    leaves = [vertex for vertex, adjacent in neighbors.items() if len(adjacent) == 1]
    while leaves:
        vertex = leaves.pop()
        adjacent = neighbors.pop(vertex)
        for other in adjacent:
            neighbors[other].remove(vertex)
            if len(neighbors[other]) == 1:
                leaves.append(other)
    if len(neighbors) < 3 or any(len(adjacent) != 2 for adjacent in neighbors.values()):
        raise ValueError("Room edges do not form one closed outline.")
    start = next(iter(neighbors))
    loop = [start, next(vertex for vertex in neighbors if vertex in neighbors[start])]
    while loop[-1] != start:
        (following,) = neighbors[loop[-1]] - {loop[-2]}
        loop.append(following)
    if len(loop) != len(neighbors) + 1:
        raise ValueError("Room edges do not form one closed outline.")
    points = [vertices[v] for v in loop[:-1]]
    if not all(math.isfinite(value) for point in points for value in point):
        raise ValueError("Room coordinates are invalid.")
    return points


def stage(points):
    # Find a small rectangle inside the outline for provisional actor and camera marks.
    edges = list(zip(points, points[1:] + points[:1]))
    x0, x1 = min(x for x, _ in points), max(x for x, _ in points)
    z0, z1 = min(z for _, z in points), max(z for _, z in points)
    for iz in sorted(range(1, 24), key=lambda n: abs(n - 12)):
        for ix in sorted(range(1, 24), key=lambda n: abs(n - 12)):
            x = x0 + (x1 - x0) * ix / 24
            z = z0 + (z1 - z0) * iz / 24
            left, right, front, back = x - .9, x + .9, z - 1.65, z + 1.75
            crossings = sum((az > z) != (bz > z) and
                            x < ax + (bx - ax) * (z - az) / (bz - az)
                            for (ax, az), (bx, bz) in edges)
            boundary_nearby = any(max(ax, bx) >= left and min(ax, bx) <= right and
                                  max(az, bz) >= front and min(az, bz) <= back
                                  for (ax, az), (bx, bz) in edges)
            if crossings % 2 and not boundary_nearby:
                return [[x - .6, z - 1.25], [x + .6, z - 1.25]], [x, z + 1.45]
    raise ValueError("Could not place the starter shot inside the returned outline.")


def read_model(model_id, *, interactive=True, query=QUERY, timeout=45):
    key = os.getenv("MATTERPORT_API_KEY")
    token = os.getenv("MATTERPORT_API_TOKEN")
    if interactive:
        key = key or getpass.getpass("Matterport API key: ")
        token = token or getpass.getpass("Matterport API token: ")
    if not key or not token:
        raise ValueError("Matterport API credentials are unavailable.")
    auth = base64.b64encode(f"{key.strip()}:{token.strip()}".encode()).decode()
    request = Request("https://api.matterport.com/api/models/graph",
                      json.dumps({"query": query, "variables": {"id": model_id}}).encode(),
                      {"Authorization": f"Basic {auth}", "Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def import_rooms(model_id, payload, destination, room_id=None):
    model = (payload.get("data") or {}).get("model")
    if not model or (model.get("id") and model["id"] != model_id):
        raise ValueError("Matterport did not return model geometry.")
    floors = {floor["id"]: floor for floor in model["floors"]}
    rooms = [room for room in model["rooms"] if room_id is None or room["id"] == room_id]
    if not rooms:
        raise ValueError("No matching rooms in API response.")
    imported = []
    skipped = []
    for room in rooms:
        identifier = room["id"]
        if not valid_id(identifier):
            skipped.append((identifier, "Unsupported room identifier"))
            continue
        try:
            points = outline(room, floors[room["floor"]["id"]])
            area = abs(sum(a[0] * b[1] - b[0] * a[1]
                           for a, b in zip(points, points[1:] + points[:1]))) / 2
            if area < .01:
                raise ValueError("Room outline has negligible area.")
        except (ValueError, KeyError, TypeError) as error:
            skipped.append((identifier, str(error)))
            continue
        height = (room.get("dimensions") or {}).get("height")
        if not isinstance(height, (int, float)) or not 0 < height < math.inf:
            height = None
        labels = room.get("classifications") or []
        label = next((entry.get("label") for entry in labels if entry.get("label")), None)
        record = {
            "schemaVersion": 1, "modelId": model_id, "roomId": identifier,
            "floorId": room["floor"]["id"], "label": label or f"Room {identifier}",
            "units": "meters", "outline": points, "height": height,
            "geometrySource": "Matterport room boundary", "staging": "provisional",
        }
        try:
            record["actors"], record["camera"] = stage(points)
        except ValueError:
            record["actors"] = []
        target = destination / model_id / f"{identifier}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("x", encoding="utf-8") as file:
                json.dump(record, file, indent=2, allow_nan=False)
        except FileExistsError:
            skipped.append((identifier, "Already imported"))
            continue
        imported.append(target)
    return imported, skipped


def import_measured_room(model_id, room_id, payload, destination):
    """Import an operator-measured room in the scan's horizontal axes."""
    if not valid_id(room_id) or not isinstance(payload, dict):
        raise ValueError("A measured import needs a room identifier and a JSON object.")
    points = payload.get("outline")
    source = payload.get("source")
    if payload.get("units") != "meters" or not isinstance(source, str) or not source.strip():
        raise ValueError("Supply meter units and a measurement source.")
    if not isinstance(points, list) or not 3 <= len(points) <= 500 or any(
            not isinstance(point, list) or len(point) != 2 or any(
                type(value) not in (int, float) or not math.isfinite(value) for value in point)
            for point in points):
        raise ValueError("Supply at least three finite [x, z] points in boundary order.")
    if points[0] == points[-1]:
        points = points[:-1]
    if len(set(map(tuple, points))) != len(points) or len(points) < 3:
        raise ValueError("Outline vertices must be distinct.")
    edges = list(zip(points, points[1:] + points[:1]))
    def orientation(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    for index, (a, b) in enumerate(edges):
        for other in range(index + 2, len(edges)):
            if index == 0 and other == len(edges) - 1:
                continue
            c, d = edges[other]
            overlaps = all(max(min(a[i], b[i]), min(c[i], d[i])) <=
                           min(max(a[i], b[i]), max(c[i], d[i])) for i in (0, 1))
            if overlaps and orientation(a, b, c) * orientation(a, b, d) <= 0 and (
                    orientation(c, d, a) * orientation(c, d, b) <= 0):
                raise ValueError("Outline edges must not cross or touch.")
    if abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)) < .02:
        raise ValueError("Room outline has negligible area.")
    height = payload.get("height")
    if height is not None and (type(height) not in (int, float) or not 0 < height < math.inf):
        raise ValueError("Height must be a positive meter value.")
    label = payload.get("label")
    if label is not None and (not isinstance(label, str) or not 0 < len(label.strip()) <= 100):
        raise ValueError("Room label must contain 1–100 characters.")
    record = {
        "schemaVersion": 1, "modelId": model_id, "roomId": room_id,
        "label": label or f"Room {room_id}", "units": "meters",
        "outline": points, "height": height, "actors": [],
        "geometrySource": "Operator-measured boundary: " + source.strip(),
        "staging": "unplaced", "matterpakAlignmentVerified": False,
    }
    target = destination / model_id / f"{room_id}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as file:
        json.dump(record, file, indent=2, allow_nan=False)
    return target


def valid_id(value):
    return isinstance(value, str) and 1 <= len(value) <= 128 and all(
        character.isascii() and (character.isalnum() or character in "-_") for character in value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model")
    parser.add_argument("--room")
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--response", type=Path, help="Read a saved GraphQL JSON response")
    inputs.add_argument("--measured", type=Path, help="Import a locally measured metric room outline")
    parser.add_argument("--assets", type=Path, default=DEFAULT_ASSETS)
    args = parser.parse_args()
    if not valid_id(args.model) or not args.model.isalnum() or len(args.model) > 40:
        parser.error("Invalid model ID.")
    try:
        destination = args.assets / "rooms"
        if args.measured:
            imported = [import_measured_room(args.model, args.room, json.loads(args.measured.read_text()), destination)]
            skipped = []
        else:
            payload = json.loads(args.response.read_text()) if args.response else read_model(args.model)
            imported, skipped = import_rooms(args.model, payload, destination, args.room)
    except (URLError, OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"Room import stopped: {error}\n")
    for target in imported:
        print(f"Imported {target}")
    for identifier, reason in skipped:
        print(f"Skipped {identifier}: {reason}")
    if not imported:
        parser.exit(1, "No new room outlines were imported.\n")


if __name__ == "__main__":
    main()
