"""Relay one bounded chat-completions tool turn to the configured provider."""
import json
import os
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def configured():
    return bool(os.getenv("SCOUT_MODEL_URL") and os.getenv("SCOUT_MODEL_NAME"))


def next_turn(payload):
    if not configured():
        raise RuntimeError("Set SCOUT_MODEL_URL and SCOUT_MODEL_NAME to enable the agent.")
    url = os.environ["SCOUT_MODEL_URL"]
    endpoint = urlsplit(url)
    local_http = endpoint.scheme == "http" and endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
    if not endpoint.hostname or (endpoint.scheme != "https" and not local_http):
        raise RuntimeError("Use an HTTPS provider endpoint or a local model.")
    headers = {"Content-Type": "application/json"}
    if key := os.getenv("SCOUT_MODEL_KEY"):
        headers["Authorization"] = "Bearer " + key
    body = json.dumps({**payload, "model": os.environ["SCOUT_MODEL_NAME"]}).encode()
    try:
        with urlopen(Request(url, body, headers), timeout=45) as response:
            result = json.load(response)
        return result["choices"][0]["message"]
    except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError):
        raise RuntimeError("The configured model did not return a usable response.") from None
