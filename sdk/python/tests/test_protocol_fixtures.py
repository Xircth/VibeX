from __future__ import annotations

import unittest

from vibex_plugin.protocol_fixtures import (
    default_fixture_directory,
    load_protocol_fixtures,
    replay_protocol_fixtures,
)


class ProtocolFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def test_replays_shared_jsonl_corpus(self) -> None:
        directory = default_fixture_directory()
        fixtures = load_protocol_fixtures(directory)
        self.assertGreaterEqual(len(fixtures), 1)
        self.assertTrue(any(item.path.name == "handshake.jsonl" for item in fixtures))
        failures = await replay_protocol_fixtures(directory)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
