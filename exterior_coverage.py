"""Check Vexcel v2 coverage at a verified CoStar coordinate or block extent."""
import argparse
import json
import math
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROUTES = {"oriented": "oriented/collections", "dsm": "dsm/collections"}


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


def request_coverage(kind, query, api_key):
    url = "https://api.vexcelgroup.com/v2/" + ROUTES[kind]
    request = Request(f"{url}?{urlencode(query)}", headers={"X-API-KEY": api_key})
    try:
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            metadata = json.load(response)
            return {"http": response.status, "coverage_metadata": metadata}
    except HTTPError as error:
        return {"http": error.code, "error": "Vexcel rejected the coverage request"}
    except URLError:
        return {"error": "Could not connect to Vexcel"}
    except ValueError:
        return {"error": "Vexcel did not return JSON coverage metadata"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("property_id", type=int)
    parser.add_argument("longitude", type=float)
    parser.add_argument("latitude", type=float)
    parser.add_argument("--block", type=float, nargs=4, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--plan", action="store_true", help="Print token-free requests without sending them")
    args = parser.parse_args()
    if not all(map(math.isfinite, (args.longitude, args.latitude, *(args.block or [])))):
        parser.error("Coordinates must be finite.")
    try:
        queries = coverage_queries(args.longitude, args.latitude, args.block)
    except ValueError as error:
        parser.error(str(error))
    api_key = os.getenv("VEXCEL_API_KEY", "").strip()
    if not args.plan and not api_key:
        parser.error("VEXCEL_API_KEY is required for live coverage.")
    results = {
        kind: {"route": route, "query": queries[kind]} if args.plan
        else request_coverage(kind, queries[kind], api_key)
        for kind, route in ROUTES.items()
    }
    print(json.dumps({"property_id": args.property_id, "results": results}, indent=2))


if __name__ == "__main__":
    main()
