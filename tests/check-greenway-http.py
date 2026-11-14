"""Run with Python 3 and Node 24: python3 tests/check-greenway-http.py DATA_DIR."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import ScoutServer


class ScriptedProvider(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        round_number = sum(message["role"] == "assistant" for message in request["messages"])
        model = "39kv7R6xV7o"
        rounds = [
            [("search_locations", {"query": "greenway", "city": "Houston", "importedOnly": True})],
            [
                ("get_room_evidence", {"model": model, "room": None}),
                ("evaluate_shot", {"model": model, "room": None, "lens": 35,
                                   "slide": .7, "move": "slide", "requireSightlines": False}),
            ],
        ]
        message = {"content": "Finished the scripted investigation.",
                   "tool_calls": [
                       {"id": f"tool-{round_number}-{index}", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)}}
                       for index, (name, args) in enumerate(rounds[round_number])
                   ] if round_number < len(rounds) else []}
        body = json.dumps({"choices": [{"message": message}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="Directory containing the extracted preview bundle")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    database = args.data / "catalog.sqlite"
    assets = args.data / "local-assets"
    if not database.is_file() or not (assets / "room.json").is_file():
        parser.error("Extract the Greenway preview bundle into DATA_DIR first.")
    os.environ.pop("SCOUT_MODEL_KEY", None)
    with (ThreadingHTTPServer(("127.0.0.1", 0), ScriptedProvider) as provider,
          ScoutServer(("127.0.0.1", 0), database, assets) as app):
        os.environ.update(SCOUT_MODEL_URL=f"http://127.0.0.1:{provider.server_port}",
                          SCOUT_MODEL_NAME="scripted-test")
        servers = (provider, app)
        workers = [Thread(target=server.serve_forever) for server in servers]
        for worker in workers:
            worker.start()
        try:
            subprocess.run([args.node, str(ROOT / "tests/greenway-http-client.mjs"),
                            f"http://127.0.0.1:{app.server_port}"], check=True, timeout=30)
        finally:
            for server in reversed(servers):
                server.shutdown()
            for worker in workers:
                worker.join()


if __name__ == "__main__":
    main()
