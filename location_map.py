"""Resolve public catalog street addresses for Scout's map."""

import json
import math
from functools import lru_cache
from urllib.parse import urlencode
from urllib.request import urlopen

from catalog import _connect_readonly


def locate_property(database, property_id):
    with _connect_readonly(database) as connection:
        indexed = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'property_coordinates'"
        ).fetchone()
        if indexed:
            position = connection.execute(
                "SELECT latitude, longitude FROM property_coordinates WHERE property_id = ?",
                (property_id,),
            ).fetchone()
            if position and None not in position:
                return {"latitude": position[0], "longitude": position[1], "approximate": False}
        address = connection.execute(
            "SELECT street, city, state FROM locations WHERE property_id = ? LIMIT 1",
            (property_id,),
        ).fetchone()
    return locate_address(*address) if address else None


@lru_cache(maxsize=2048)
def locate_address(street, city, state):
    if not all((street, city, state)):
        return None
    query = urlencode({"address": f"{street}, {city}, {state}",
                       "benchmark": "Public_AR_Current", "format": "json"})
    with urlopen("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + query,
                 timeout=8) as response:
        matches = json.load(response)["result"]["addressMatches"]
    if not matches:
        return None
    coordinates = matches[0]["coordinates"]
    lat, lon = coordinates["y"], coordinates["x"]
    if not (math.isfinite(lat) and abs(lat) <= 90 and math.isfinite(lon) and abs(lon) <= 180):
        return None
    return {"latitude": lat, "longitude": lon, "approximate": True}
