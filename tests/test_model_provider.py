import io
import json
import unittest
from unittest.mock import patch

from model_provider import next_turn


class ModelProviderTest(unittest.TestCase):
    def relay(self, choice):
        with (patch.dict("os.environ", {
            "SCOUT_MODEL_URL": "http://127.0.0.1:1234",
            "SCOUT_MODEL_NAME": "fixture",
        }, clear=True), patch("model_provider.urlopen", return_value=io.BytesIO(
            json.dumps({"choices": [choice]}).encode(),
        ))):
            return next_turn({"messages": [], "tools": []})

    def test_accepts_content_and_tool_turns(self):
        for message in [
            {"content": "Finished"},
            {"content": None, "tool_calls": [
                {"id": "call-1", "function": {"name": "inspect_location", "arguments": "{}"}},
            ]},
        ]:
            with self.subTest(message=message):
                self.assertEqual(self.relay({"message": message}), message)

    def test_rejects_incomplete_or_malformed_turns(self):
        for choice in [
            {"finish_reason": "length", "message": {"content": "Partial answer"}},
            {"finish_reason": "content_filter", "message": {"content": "Partial answer"}},
            {"message": None},
            {"message": {"content": ""}},
            {"message": {"tool_calls": {"id": "call-1"}}},
            {"message": {"tool_calls": [{"id": "call-1", "function": {"name": "inspect_location"}}]}},
        ]:
            with self.subTest(choice=choice):
                with self.assertRaisesRegex(RuntimeError, "did not return a usable response"):
                    self.relay(choice)
