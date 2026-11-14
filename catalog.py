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
        for row in csv.DictReader(links):
            if model := row["MatterportModelId"]:
                models[int(row["PropertyId"])][model] = None

        for line in properties:
            record = json.loads(line)
            address = record["primaryAddress"]
            property_id = record["id"]
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


def starter_records(kit):
    properties = {}
    with (kit / "commercial-properties.csv").open(encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            property_id = int(row["PropertyId"])
            prior = properties.setdefault(property_id, (row, {}))
            if model := row["MatterportModelId"]:
                prior[1][model] = None
    for property_id, (row, models) in properties.items():
        street = row["Address"]
        yield (property_id, street, street, row["City"], row["State"],
               "", "", "", json.dumps(models))


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


def source_mode(database):
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        if not connection.execute("SELECT EXISTS(SELECT 1 FROM locations)").fetchone()[0]:
            raise sqlite3.OperationalError("Empty catalog")
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'catalog_source'").fetchone():
            return "full"
        return connection.execute("SELECT mode FROM catalog_source").fetchone()[0]


def search(database, brief, limit=12, *, city="", category="", linked_only=False, imported_models=None):
    terms = list(dict.fromkeys(re.findall(r"[a-z0-9]+", brief.lower())))
    terms = [term for term in terms if term not in
             {"a", "an", "the", "in", "with", "for", "by", "find", "me", "and"}][:24]
    clauses = []
    values = []
    if terms:
        clauses.append("locations MATCH ?")
        values.append(" OR ".join(f'"{term}"' for term in terms))
    if city.strip():
        clauses.append("lower(city) = lower(?)")
        values.append(city.strip())
    if category.strip():
        clauses.append("lower(category) = lower(?)")
        values.append(category.strip())
    if linked_only:
        clauses.append("models <> '{}'")
    if imported_models is not None:
        if not imported_models:
            return []
        clauses.append("EXISTS (SELECT 1 FROM json_each(locations.models) AS scan "
                       "WHERE scan.key IN (SELECT value FROM json_each(?)))")
        values.append(json.dumps(sorted(imported_models)))
    if not clauses:
        return []
    evidence = "snippet(locations, -1, '[', ']', ' … ', 18)" if terms else "substr(notes, 1, 300)"
    rank = "bm25(locations, 0, 5, 5, 4, 2, 4, 1, 2, 0), " if terms else ""
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(f"""SELECT property_id, name, street, city, state,
            category, models, {evidence} AS evidence
            FROM locations WHERE {" AND ".join(clauses)}
            ORDER BY {rank}property_id LIMIT ?""", (*values, limit))
        return [{**dict(row), "models": json.loads(row["models"])} for row in rows]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("catalog.sqlite"))
    commands = parser.add_subparsers(dest="action", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("kit", type=Path)
    build_parser.add_argument("--password-prompt", action="store_true")
    commands.add_parser("search").add_argument("brief")
    args = parser.parse_args()
    if args.action == "build":
        password = getpass.getpass("CoStar kit ZIP password: ").encode() if args.password_prompt else None
        try:
            print(f"Indexed {build(args.db, args.kit, password)} properties")
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
            parser.exit(1, f"Catalog import stopped: {error}\n")
    else:
        print(json.dumps(search(args.db, args.brief), indent=2))
