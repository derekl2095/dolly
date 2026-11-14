"""Check Vexcel v2 coverage and choose an oblique captured near a requested hour."""
import argparse
import json
import math
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROUTES = {"oriented": "oriented/collections", "dsm": "dsm/collections"}
OBLIQUE_TYPES = ("oblique-north", "oblique-east", "oblique-south", "oblique-west")
ROOT = Path(__file__).resolve().parent


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def coverage_queries(longitude, latitude, block=None):
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        raise ValueError("Expected WGS84 longitude and latitude.")
    point = f"POINT({longitude} {latitude})"
    area = point
    if block is not None:
        west, south, east, north = block
        if not (-180 <= west < longitude < east <= 180 and
                -90 <= south < latitude < north <= 90):
            raise ValueError("Block bounds must enclose the site and use WGS84 degrees.")
        corners = [(west, south), (east, south), (east, north), (west, north), (west, south)]
        area = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in corners) + "))"
    return {kind: {"wkt": wkt, "srid": 4326, "metadata-format": "JSON"}
            for kind, wkt in (("oriented", point), ("dsm", area))}


def request_json(path, query, key, timeout=30):
    url = "https://api.vexcelgroup.com/v2/" + path
    headers = {"X-API-KEY": key} if key else {}
    request = Request(f"{url}?{urlencode(query)}", headers=headers)
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            return {"http": response.status, "metadata": json.load(response)}
    except HTTPError as error:
        return {"http": error.code, "error": "Vexcel rejected the request"}
    except URLError:
        return {"error": "Could not connect to Vexcel"}
    except ValueError:
        return {"error": "Vexcel did not return JSON"}


def request_coverage(kind, query, key):
    result = request_json(ROUTES[kind], query, key, timeout=20)
    if "metadata" in result:
        return {"http": result["http"], "coverage_metadata": result["metadata"]}
    return result


def capture_hour(value):
    clock = value.split("T", 1)[1].replace("Z", "")
    hour, minute = clock.split(":", 2)[:2]
    return int(hour) + int(minute) / 60


def hour_gap(left, right):
    distance = abs(left - right) % 24
    return min(distance, 24 - distance)


def capture_records(metadata):
    records = []
    for feature in metadata.get("features") or []:
        props = feature.get("properties") or {}
        name = props.get("image-name")
        taken = props.get("capture-date")
        if not name or not taken or "T" not in taken:
            continue
        records.append({
            "image-name": name,
            "capture-date": taken,
            "collection": props.get("collection"),
            "layer": props.get("layer") or "urban",
            "product-type": props.get("product-type"),
            "hour": capture_hour(taken),
        })
    return records


def closest_capture(records, hour):
    if not records:
        raise ValueError("No dated captures.")
    if not math.isfinite(hour) or not 0 <= hour < 24:
        raise ValueError("Hour must be from 0 up to 24.")
    best = None
    best_gap = None
    for record in records:
        gap = hour_gap(record["hour"], hour)
        later = best is not None and record["capture-date"] > best["capture-date"]
        if best is None or gap < best_gap or (gap == best_gap and later):
            best = record
            best_gap = gap
    return {**best, "hours-from-request": best_gap}


def newest_oblique_collection(metadata):
    groups = {}
    for feature in metadata.get("features") or []:
        props = feature.get("properties") or {}
        kind = props.get("product-type") or ""
        collection = props.get("collection")
        if kind not in OBLIQUE_TYPES or not collection:
            continue
        group = groups.setdefault(collection, {
            "collection": collection,
            "layer": props.get("layer") or "urban",
            "last-capture-date": "",
            "directions": set(),
        })
        group["directions"].add(kind)
        taken = props.get("last-capture-date") or ""
        if taken > group["last-capture-date"]:
            group["last-capture-date"] = taken
            if props.get("layer"):
                group["layer"] = props["layer"]
    if not groups:
        raise ValueError("No oblique coverage.")
    best = max(groups.values(), key=lambda group: group["last-capture-date"])
    best["directions"] = [kind for kind in OBLIQUE_TYPES if kind in best["directions"]]
    return best


def image_query(longitude, latitude, product_type, layer="urban", collection=None):
    query = {
        "wkt": f"POINT({longitude} {latitude})",
        "srid": 4326,
        "layer": layer,
        "product-type": product_type,
        "metadata-format": "JSON",
        "include": "image-name,capture-date,collection,product-type,layer",
        "page-size": 100,
    }
    if collection:
        query["collection"] = collection
    return query


def lighting_choices(records, hour):
    grouped = {}
    for record in records:
        if record.get("product-type") in OBLIQUE_TYPES:
            grouped.setdefault(record["product-type"], []).append(record)
    return [closest_capture(grouped[kind], hour) for kind in OBLIQUE_TYPES if kind in grouped]


def facade_body(record, longitude, latitude):
    return {
        "wkt": f"POINT({longitude} {latitude})",
        "srid": 4326,
        "layer": record.get("layer") or "urban",
        "image-name": record["image-name"],
        "product-type": record["product-type"],
        "rotation": "natural",
        "downsample": 2,
        "attribution": True,
        "image-format": "jpeg",
    }


def request_image(path, body, key, timeout=120):
    url = "https://api.vexcelgroup.com/v2/" + path
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-KEY"] = key
    request = Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            content = response.read()
            if not content.startswith(b"\xff\xd8"):
                return {"http": response.status, "error": "Vexcel did not return a JPEG"}
            return {"http": response.status, "body": content}
    except HTTPError as error:
        return {"http": error.code, "error": "Vexcel rejected the image request"}
    except URLError:
        return {"error": "Could not connect to Vexcel"}


def save_facade(record, longitude, latitude, key, destination):
    result = request_image("oriented/extract", facade_body(record, longitude, latitude), key)
    if "body" not in result:
        return result
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(result["body"])
    return {"http": result["http"], "bytes": len(result["body"]), "path": str(destination)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("property_id", type=int)
    parser.add_argument("longitude", type=float)
    parser.add_argument("latitude", type=float)
    parser.add_argument("--block", type=float, nargs=4, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--plan", action="store_true", help="Print key-free requests without sending them")
    parser.add_argument("--time", type=float, metavar="HOUR",
                        help="Clock hour from 0 up to 24. Choose the oblique closest to this time.")
    parser.add_argument("--direction", default="oblique-north", choices=OBLIQUE_TYPES)
    parser.add_argument("--facade", action="store_true",
                        help="Save the JPEG for --direction at the requested hour.")
    args = parser.parse_args()
    if not all(map(math.isfinite, (args.longitude, args.latitude, *(args.block or [])))):
        parser.error("Coordinates must be finite.")
    if args.time is not None and (not math.isfinite(args.time) or not 0 <= args.time < 24):
        parser.error("Hour must be from 0 up to 24.")
    if args.plan and args.time is not None:
        parser.error("--time requests live imagery, so it cannot be combined with --plan.")
    try:
        queries = coverage_queries(args.longitude, args.latitude, args.block)
    except ValueError as error:
        parser.error(str(error))
    key = os.getenv("VEXCEL_API_KEY", "").strip()
    if not args.plan and not key:
        parser.error("VEXCEL_API_KEY is required for live coverage.")
    if args.time is None:
        results = {
            kind: {"route": route, "query": queries[kind]} if args.plan
            else request_coverage(kind, queries[kind], key)
            for kind, route in ROUTES.items()
        }
        print(json.dumps({"property_id": args.property_id, "results": results}, indent=2))
        return
    records = []
    errors = []
    for direction in OBLIQUE_TYPES:
        result = request_json("oriented/query", image_query(
            args.longitude, args.latitude, direction), key)
        if "metadata" in result:
            records.extend(capture_records(result["metadata"]))
        else:
            errors.append({"product-type": direction, **result})
    if not records:
        print(json.dumps({"property_id": args.property_id, "errors": errors,
                          "error": "No dated oblique captures."}, indent=2))
        sys.exit(1)
    matches = lighting_choices(records, args.time)
    for match in matches:
        match["hours-from-request"] = round(match["hours-from-request"], 2)
        match["available_hours"] = sorted({
            record["capture-date"][11:16] for record in records
            if record["product-type"] == match["product-type"]})
    report = {
        "property_id": args.property_id,
        "requested_hour": args.time,
        "matches": matches,
        "errors": errors,
    }
    if args.facade:
        selected = next((match for match in matches if match["product-type"] == args.direction), None)
        if selected is None:
            report["facade"] = {"error": "No capture for the requested direction."}
        else:
            stamp = selected["capture-date"].replace(":", "").replace("-", "")
            destination = (ROOT / "capture-cache" / "vexcel" /
                           f"{args.property_id}-{selected['product-type']}-{stamp}.jpg")
            report["facade"] = save_facade(selected, args.longitude, args.latitude, key, destination)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
