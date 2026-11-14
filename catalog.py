"""Build and search a local scouting index from the extracted CoStar kit."""
import argparse
import csv
import getpass
import io
import json
import re
import sqlite3
import zipfile
from contextlib import contextmanager
from collections import defaultdict
from pathlib import Path


@contextmanager
def kit_files(kit, password):
    if kit.is_file():
        with zipfile.ZipFile(kit) as archive:
            if password:
                archive.setpassword(password)
            with (io.TextIOWrapper(archive.open("commercial-properties.csv"), encoding="utf-8-sig") as links,
                  io.TextIOWrapper(archive.open("data/commercial-property.jsonl"), encoding="utf-8") as properties):
                yield links, properties
    else:
        with ((kit / "commercial-properties.csv").open(encoding="utf-8-sig") as links,
              (kit / "data/commercial-property.jsonl").open(encoding="utf-8") as properties):
            yield links, properties


def records(kit, password=None):
    models = defaultdict(dict)
    with kit_files(kit, password) as (links, properties):
        addresses = {}
        for row in csv.DictReader(links):
            addresses.setdefault(int(row["PropertyId"]), row)
            if model := row["MatterportModelId"]:
                models[int(row["PropertyId"])][model] = None

        seen = set()
        for line in properties:
            record = json.loads(line)
            address = record["primaryAddress"]
            property_id = record["id"]
            if property_id in seen:
                continue
            seen.add(property_id)
            linked = models[property_id]
            for attachment in record.get("attachments") or []:
                model = attachment.get("videoKey")
                if model in linked and attachment.get("caption"):
                    linked[model] = attachment["caption"]
            street = " ".join(str(address[key]) for key in
                              ("streetNumber", "streetName", "streetType") if address.get(key))
            category = {
                1: "hotel hospitality", 2: "industrial warehouse", 3: "land", 5: "office",
                6: "retail", 7: "flex", 11: "apartment multifamily",
            }.get(record["propertyType"], "commercial")
            yield (
                property_id, record.get("buildingName") or street, street,
                address.get("city", ""), address.get("state", ""), category,
                " ".join(note["value"] for note in record.get("notes") or [] if note.get("value")),
                " ".join(filter(None, linked.values())), json.dumps(linked),
            )

        for property_id, row in addresses.items():
            if property_id not in seen:
                yield starter_record(property_id, row, models[property_id])


def starter_record(property_id, row, models):
    street = row["Address"]
    return (property_id, street, street, row["City"], row["State"],
            "", "", "", json.dumps(models))


def starter_records(kit):
    properties = {}
    with (kit / "commercial-properties.csv").open(encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            property_id = int(row["PropertyId"])
            prior = properties.setdefault(property_id, (row, {}))
            if model := row["MatterportModelId"]:
                prior[1][model] = None
    for property_id, (row, models) in properties.items():
        yield starter_record(property_id, row, models)


def build(database, kit, password=None, *, starter_only=False):
    with sqlite3.connect(database) as connection:
        connection.execute("BEGIN")
        connection.execute("DROP TABLE IF EXISTS locations")
        connection.execute("""CREATE VIRTUAL TABLE locations USING fts5(
            property_id UNINDEXED, name, street, city, state, category, notes,
            captions, models UNINDEXED, tokenize='porter unicode61')""")
        source = starter_records(kit) if starter_only else records(kit, password)
        connection.executemany("INSERT INTO locations VALUES (?,?,?,?,?,?,?,?,?)", source)
        connection.execute("CREATE TABLE IF NOT EXISTS catalog_source (mode TEXT NOT NULL)")
        connection.execute("DELETE FROM catalog_source")
        connection.execute("INSERT INTO catalog_source VALUES (?)", ("addresses" if starter_only else "full",))
        count = connection.execute("SELECT count(*) FROM locations").fetchone()[0]
        if not count:
            raise ValueError("No CoStar records could be read. Make the commercial property file available offline.")
        return count



def index_property_coordinates(database, kit, password=None):
    """Hydrate coordinates without rebuilding the existing full-text index."""
    sites = {}
    with kit_files(kit, password) as (_, properties):
        for line in properties:
            record = json.loads(line)
            address = record.get("primaryAddress") or {}
            latitude, longitude = address.get("latitude"), address.get("longitude")
            if (type(latitude) in (int, float) and -90 <= latitude <= 90
                    and type(longitude) in (int, float) and -180 <= longitude <= 180):
                sites.setdefault(record["id"], (latitude, longitude))
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS property_coordinates "
                           "(property_id INTEGER PRIMARY KEY, latitude REAL, longitude REAL)")
        connection.execute("DELETE FROM property_coordinates")
        connection.executemany("INSERT INTO property_coordinates VALUES (?, ?, ?)",
                               ((key, *values) for key, values in sites.items()))


def coordinates_indexed(database):
    with _connect_readonly(database) as connection:
        return connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'property_coordinates'").fetchone() is not None


def scan_location(database, model):
    """Return unambiguous site metadata for a catalog-linked Matterport model."""
    zones = {("houston", "TX"): "America/Chicago", ("los angeles", "CA"): "America/Los_Angeles"}
    with _connect_readonly(database) as connection:
        # Older portable catalogs still supply the city and state.
        indexed = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'property_coordinates'").fetchone()
        coordinates = ("c.latitude, c.longitude FROM locations "
                       "LEFT JOIN property_coordinates c USING (property_id)" if indexed
                       else "NULL, NULL FROM locations")
        rows = connection.execute(
            "SELECT locations.property_id, city, state, " + coordinates +
            " WHERE EXISTS (SELECT 1 FROM json_each(locations.models) WHERE key = ?) LIMIT 2",
            (model,)).fetchall()
    if len(rows) != 1:
        return None
    property_id, city, state, latitude, longitude = rows[0]
    return {"propertyId": property_id, "latitude": latitude, "longitude": longitude,
            "timeZone": zones.get(((city or "").strip().casefold(), (state or "").strip().upper())),
            "source": "CoStar primary address"}

def source_mode(database):
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        if not connection.execute("SELECT EXISTS(SELECT 1 FROM locations)").fetchone()[0]:
            raise sqlite3.OperationalError("Empty catalog")
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'catalog_source'").fetchone():
            return "full"
        return connection.execute("SELECT mode FROM catalog_source").fetchone()[0]


PAGE_LIMIT = 100
CATEGORY_ALIASES = {
    "apartment": "apartment multifamily", "multifamily": "apartment multifamily",
    "hotel": "hotel hospitality", "hospitality": "hotel hospitality",
    "industrial": "industrial warehouse", "warehouse": "industrial warehouse",
}


def _connect_readonly(database):
    return sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)


def _search_rows(database, brief, limit, offset, *, city, category, linked_only,
                 imported_models, browse):
    terms = list(dict.fromkeys(re.findall(r"[^\W_]+", brief.casefold())))
    terms = [term for term in terms if term not in
             {"a", "an", "the", "in", "with", "for", "by", "find", "me", "and"}][:24]
    clauses = []
    values = []
    if terms:
        clauses.append("locations MATCH ?")
        values.append(" OR ".join(f'"{term}"' for term in terms))
    if city.strip():
        clauses.append("lower(trim(city)) = lower(?)")
        values.append(city.strip())
    if category.strip():
        category = " ".join(category.lower().split())
        clauses.append("lower(category) = ?")
        values.append(CATEGORY_ALIASES.get(category, category))
    if linked_only:
        clauses.append("models <> '{}'")
    if imported_models is not None:
        if not imported_models:
            return []
        clauses.append("EXISTS (SELECT 1 FROM json_each(locations.models) AS scan "
                       "WHERE scan.key IN (SELECT value FROM json_each(?)))")
        values.append(json.dumps(sorted(imported_models)))
    if not clauses and not browse:
        return []
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    source = "coalesce(nullif(notes,''), nullif(captions,''), street)"
    evidence = (f"coalesce(nullif(snippet(locations, -1, '[', ']', ' … ', 18),''), "
                f"substr({source}, 1, 300))" if terms else f"substr({source}, 1, 300)")
    rank = "bm25(locations, 0, 5, 5, 4, 2, 4, 1, 2, 0), " if terms else ""
    with _connect_readonly(database) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(f"""SELECT property_id, name, street, city, state,
            category, models, {evidence} AS evidence
            FROM locations {where}
            ORDER BY {rank}property_id, rowid LIMIT ? OFFSET ?""", (*values, limit, offset))
        results = []
        for row in rows:
            models = json.loads(row["models"])
            if imported_models is not None:
                models = {model: caption for model, caption in models.items() if model in imported_models}
            results.append({**dict(row), "models": models})
        return results


def search(database, brief, limit=12, *, city="", category="", linked_only=False,
           imported_models=None, offset=0):
    """Return a list of matching properties for existing callers."""
    return _search_rows(database, brief, limit, offset, city=city, category=category,
                        linked_only=linked_only, imported_models=imported_models, browse=False)


def search_page(database, brief="", *, limit=12, offset=0, city="", category="",
                linked_only=False, imported_models=None):
    """Browse or search. Continue with next_offset and the same filters."""
    if type(limit) is not int or not 1 <= limit <= PAGE_LIMIT:
        raise ValueError(f"limit must be an integer between 1 and {PAGE_LIMIT}")
    if type(offset) is not int or not 0 <= offset < 2**63 - PAGE_LIMIT:
        raise ValueError("offset must be a nonnegative SQLite integer")
    rows = _search_rows(database, brief, limit + 1, offset, city=city, category=category,
                        linked_only=linked_only, imported_models=imported_models, browse=True)
    return {"results": rows[:limit], "next_offset": offset + limit if len(rows) > limit else None}


def inventory(database):
    """Count rows by observed category and market in the selected catalog."""
    with _connect_readonly(database) as connection:
        connection.row_factory = sqlite3.Row
        groups = connection.execute("""SELECT upper(trim(city)) AS city, state, category,
            count(*) AS properties, sum(models <> '{}') AS linked
            FROM locations GROUP BY upper(trim(city)), state, category
            ORDER BY state, city, category""")
        coverage = [dict(row) for row in groups]
    total = sum(row["properties"] for row in coverage)
    linked = sum(row["linked"] for row in coverage)
    return {"mode": source_mode(Path(database)), "properties": total, "linked": linked,
            "without_scans": total - linked, "coverage": coverage}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("catalog.sqlite"))
    commands = parser.add_subparsers(dest="action", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("kit", type=Path)
    build_parser.add_argument("--password-prompt", action="store_true")
    search_parser = commands.add_parser("search")
    search_parser.add_argument("brief", nargs="?", default="")
    search_parser.add_argument("--city", default="")
    search_parser.add_argument("--category", default="")
    search_parser.add_argument("--linked-only", action="store_true")
    search_parser.add_argument("--limit", type=int, default=12)
    search_parser.add_argument("--offset", type=int, default=0)
    commands.add_parser("inventory")
    coords = commands.add_parser("index-coordinates")
    coords.add_argument("kit", type=Path)
    coords.add_argument("--password-prompt", action="store_true")
    locate = commands.add_parser("scan-location")
    locate.add_argument("model")
    args = parser.parse_args()
    if args.action == "build":
        password = getpass.getpass("CoStar kit ZIP password: ").encode() if args.password_prompt else None
        try:
            print(f"Indexed {build(args.db, args.kit, password)} properties")
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
            parser.exit(1, f"Catalog import stopped: {error}\n")
    elif args.action == "index-coordinates":
        password = getpass.getpass("CoStar kit ZIP password: ").encode() if args.password_prompt else None
        try:
            index_property_coordinates(args.db, args.kit, password)
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
            parser.exit(1, f"Coordinate import stopped: {error}\n")
    elif args.action == "scan-location":
        print(json.dumps(scan_location(args.db, args.model), indent=2))
    elif args.action == "inventory":
        print(json.dumps(inventory(args.db), indent=2))
    else:
        try:
            page = search_page(args.db, args.brief, city=args.city, category=args.category,
                               linked_only=args.linked_only, limit=args.limit, offset=args.offset)
        except ValueError as error:
            search_parser.error(str(error))
        print(json.dumps(page, indent=2))
