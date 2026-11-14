"""Room calibration and direct sunlight in the aligned MatterPak frame."""
import math
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def number(value, low, high):
    if type(value) not in (int, float) or not low <= value <= high:
        raise ValueError("Expected a finite value in the supported range.")
    return value


def point(value):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("Expected [x, y, z] in meters.")
    return [number(v, -10000, 10000) for v in value]


def subtract(a, b):
    return [x - y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    x, y, z = a
    u, v, w = b
    return [y*w-z*v, z*u-x*w, x*v-y*u]


def profile(data):
    if not isinstance(data, dict):
        raise ValueError("Supply a daylight profile.")
    try:
        ZoneInfo(data.get("timeZone"))
    except (ZoneInfoNotFoundError, TypeError, ValueError) as error:
        raise ValueError("Enter a valid IANA time zone, such as America/Chicago.") from error
    source = data.get("windows")
    if not isinstance(source, list) or not 1 <= len(source) <= 32:
        raise ValueError("Enter one to 32 windows.")
    windows = {}
    for window in source:
        if not isinstance(window, dict):
            raise ValueError("Invalid window.")
        identifier = window.get("id")
        corners = window.get("corners")
        measured = window.get("source")
        if (not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", identifier)
                or identifier in windows or not isinstance(corners, list) or len(corners) != 4
                or not isinstance(measured, str) or not 0 < len(measured.strip()) <= 250):
            raise ValueError("Each window needs a unique ID, four corners and a measurement source.")
        vertices = [point(corner) for corner in corners]
        normal = point(window.get("outward"))
        length = math.hypot(*normal)
        if length < 1e-6:
            raise ValueError("Window outward direction must be nonzero.")
        normal = [value / length for value in normal]
        edges = [subtract(vertices[(i+1)%4], vertex) for i, vertex in enumerate(vertices)]
        turns = [dot(cross(edge, edges[(i+1)%4]), normal) for i, edge in enumerate(edges)]
        if (any(abs(dot(edge, normal)) > .02 for edge in edges)
                or not (min(turns) > 1e-4 or max(turns) < -1e-4)):
            raise ValueError("Window corners must form a planar convex opening in perimeter order.")
        calibrated = {"id": identifier, "corners": vertices, "outward": normal, "source": measured.strip()}
        reference = window.get("exterior")
        if reference is not None:
            if not isinstance(reference, dict) or not isinstance(reference.get("datum"), str) or not reference["datum"].strip():
                raise ValueError("Exterior window center needs a vertical datum.")
            calibrated["exterior"] = {
                "longitude": number(reference.get("longitude"), -180, 180),
                "latitude": number(reference.get("latitude"), -90, 90),
                "elevationMeters": number(reference.get("elevationMeters"), -1000, 10000),
                "datum": reference["datum"],
            }
        windows[identifier] = calibrated
    return {"latitude": number(data.get("latitude"), -90, 90),
            "longitude": number(data.get("longitude"), -180, 180),
            "heading": number(data.get("heading"), 0, 360) % 360,
            "timeZone": data["timeZone"], "windows": list(windows.values())}


def solar(instant, latitude, longitude, heading):
    # Fractional-year approximation using UTC and an east-positive longitude.
    day = instant.timetuple().tm_yday
    clock = (instant.hour * 60 + instant.minute + instant.second / 60)
    gamma = math.tau / 365.2422 * (day - 1 + (clock / 60 - 12) / 24)
    c, s = math.cos, math.sin
    equation = 229.18*(.000075+.001868*c(gamma)-.032077*s(gamma)
                       -.014615*c(2*gamma)-.040849*s(2*gamma))
    decl = (.006918-.399912*c(gamma)+.070257*s(gamma)-.006758*c(2*gamma)
            +.000907*s(2*gamma)-.002697*c(3*gamma)+.001480*s(3*gamma))
    ha = math.radians((clock + equation + longitude*4)/4 - 180)
    lat = math.radians(latitude)
    east = -c(decl)*s(ha)
    north = c(lat)*s(decl)-s(lat)*c(decl)*c(ha)
    up = s(lat)*s(decl)+c(lat)*c(decl)*c(ha)
    bearing = math.radians(heading)
    return {"azimuth": math.degrees(math.atan2(east, north)) % 360,
            "elevation": math.degrees(math.asin(max(-1, min(1, up)))),
            "direction": [east*c(bearing)-north*s(bearing), up, east*s(bearing)+north*c(bearing)]}


def instants(data, time_zone=None):
    if "localDate" in data:
        value = data["localDate"]
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("Supply a local date in YYYY-MM-DD format.")
        local = datetime.fromisoformat(value).replace(tzinfo=ZoneInfo(time_zone))
        data = {"start": local.isoformat(), "end": (local + timedelta(days=1)).isoformat(),
                "stepMinutes": 15}

    def parse(value):
        if not isinstance(value, str):
            raise ValueError("Supply an ISO timestamp with a UTC offset.")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or not 1900 <= parsed.year <= 2100:
            raise ValueError("Supply an offset and a year from 1900 to 2100.")
        return parsed.astimezone(timezone.utc)
    if "at" in data:
        return [parse(data["at"])]
    start, end = parse(data.get("start")), parse(data.get("end"))
    step = data.get("stepMinutes", 15)
    if type(step) is not int or not 1 <= step <= 60 or not timedelta(0) <= end-start <= timedelta(days=2):
        raise ValueError("Use a positive step of 1–60 minutes and a range of up to two days.")
    count = (end-start)//timedelta(minutes=step) + 1
    if count > 289:
        raise ValueError("A study can contain up to 289 samples.")
    return [start+timedelta(minutes=i*step) for i in range(count)]


def aperture_distance(origin, direction, window):
    normal = window["outward"]
    if dot(direction, normal) <= 1e-8:
        return None
    corners = window["corners"]
    distance = dot(subtract(corners[0], origin), normal)/dot(direction, normal)
    if distance <= 0:
        return None
    hit = [v + distance*d for v, d in zip(origin, direction)]
    sides = [dot(cross(subtract(corners[(i+1)%4], v), subtract(hit, v)), normal)
             for i, v in enumerate(corners)]
    return distance if min(sides) >= -1e-6 or max(sides) <= 1e-6 else None


def exterior_status(window, sun, grid):
    """Sample a normalized WGS84 DSM with meter elevations and matching datum."""
    reference = window.get("exterior")
    if not reference or not isinstance(grid, dict) or grid.get("crs") != "EPSG:4326" or (
            grid.get("units") != "meters" or grid.get("datum") != reference["datum"]):
        return "exterior-unknown"
    try:
        west, south, east, north = grid["bounds"]
        rows = grid["heights"]
        width = len(rows[0])
        height = len(rows)
        if width < 2 or height < 2 or not west < east or not south < north:
            return "exterior-unknown"
        lon, lat = reference["longitude"], reference["latitude"]
        meters_per_lon = 111320*math.cos(math.radians(lat))
        if meters_per_lon < 100:
            return "exterior-unknown"
        pixel = min((east-west)*meters_per_lon/width, (north-south)*111320/height)
        if not .1 <= pixel <= 10:
            return "exterior-unknown"
        az, elevation = map(math.radians, (sun["azimuth"], sun["elevation"]))
        step = pixel / 2
        unknown = False
        # Start outside the wall to avoid counting the window's own façade.
        for i in range(math.ceil(2/step), math.ceil(150/step)+1):
            distance = i*step
            u = lon + distance*math.sin(az)/meters_per_lon
            v = lat + distance*math.cos(az)/111320
            col = math.floor((u-west)/(east-west)*width)
            row = math.floor((north-v)/(north-south)*height)
            if not 0 <= row < height or not 0 <= col < width:
                unknown = True
                continue
            surface = rows[row][col]
            if type(surface) not in (int, float) or not math.isfinite(surface):
                unknown = True
                continue
            if surface > reference["elevationMeters"] + distance*math.tan(elevation):
                return "exterior-blocked"
        return "exterior-unknown" if unknown else "clear-in-coverage"
    except (KeyError, ValueError, TypeError, IndexError, OverflowError):
        return "exterior-unknown"


def study(calibration, times, actors, grid=None):
    zone = ZoneInfo(calibration["timeZone"])
    frames = []
    for instant in times:
        sun = solar(instant, calibration["latitude"], calibration["longitude"], calibration["heading"])
        direction = sun["direction"]
        windows = []
        for window in calibration["windows"]:
            if sun["elevation"] <= 0:
                verdict = "below-horizon"
            elif dot(direction, window["outward"]) <= 1e-8:
                verdict = "behind-facade"
            else:
                verdict = exterior_status(window, sun, grid)
            viable = verdict in {"exterior-unknown", "clear-in-coverage"}
            windows.append({"id": window["id"], "status": verdict,
                            "reason": verdict.replace("-", " "),
                            "actorApertureMeters": [aperture_distance(actor, direction, window) if viable else None
                                                    for actor in actors]})
        frames.append({"at": instant.isoformat(), "localTime": instant.astimezone(zone).isoformat(),
                       "sun": sun, "windows": windows})
    return frames
