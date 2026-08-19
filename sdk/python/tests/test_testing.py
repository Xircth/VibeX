from __future__ import annotations

import unittest

from vibex_plugin import PluginSdkError, define_plugin_worker
from vibex_plugin.testing import MemoryHostClient, create_worker_harness


class TestingHarnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_memory_storage_secrets_artifact_and_doctor(self) -> None:
        async def setup(registrar, environment) -> None:
            async def run(_value, env):
                host = env.host
                await host.call("storage.settings", "put", {"theme": "dark"})
                settings = await host.call("storage.settings", "get", {})
                await host.call("storage.kv", "put", {"key": "n", "value": 1})
                listed = await host.call("storage.kv", "list", {})
                await host.call("secrets", "put", {"name": "token", "value": "s3cret"})
                secret = await host.call("secrets", "get", {"name": "token"})
                await host.call(
                    "storage.database",
                    "execute",
                    {"sql": "CREATE TABLE items (id INTEGER, name TEXT)", "params": []},
                )
                await host.call(
                    "storage.database",
                    "execute",
                    {"sql": "INSERT INTO items (id, name) VALUES (?, ?)", "params": [1, "a"]},
                )
                rows = await host.call(
                    "storage.database",
                    "query",
                    {"sql": "SELECT id, name FROM items", "params": []},
                )
                written = await host.call(
                    "artifact",
                    "writeText",
                    {"content": "hello", "expectedRevision": "sha256:test-0"},
                )
                read = await host.call("artifact", "readText", {})
                lease = await host.call(
                    "artifact.preview",
                    "open",
                    {"artifactHandle": "h1", "providerId": "preview"},
                )
                await host.call("artifact.preview", "close", {"leaseId": lease["leaseId"]})
                await host.call("log", "info", {"message": "ok", "fields": {"token": "abc"}})
                doctor = await host.call("plugin.self", "doctor", {})
                return {
                    "settings": settings,
                    "listed": listed,
                    "secret": secret,
                    "rows": rows,
                    "written": written,
                    "read": read,
                    "doctor": doctor,
                }

            registrar.handle("run", run)

        harness = await create_worker_harness(define_plugin_worker(setup))
        result = await harness.invoke("run", None)
        self.assertEqual(result["settings"], {"theme": "dark"})
        self.assertEqual(result["listed"], ["n"])
        self.assertEqual(result["secret"], {"present": True, "value": "s3cret"})
        self.assertEqual(result["rows"]["rows"], [{"id": 1, "name": "a"}])
        self.assertTrue(str(result["written"]["revision"]).startswith("sha256:"))
        self.assertEqual(result["read"]["content"], "hello")
        self.assertNotIn("grants", result["doctor"])
        self.assertEqual(result["doctor"]["recentCrashes"], [])
        self.assertEqual(harness.host.logs[0]["fields"]["token"], "[redacted]")
        await harness.dispose()

    async def test_unimplemented_catalog_operations_fail_hard(self) -> None:
        async def setup(registrar, environment) -> None:
            async def run(_value, env):
                await env.host.call("network", "fetch", {"url": "https://example.com"})

            registrar.handle("run", run)

        harness = await create_worker_harness(define_plugin_worker(setup))
        with self.assertRaises(PluginSdkError) as raised:
            await harness.invoke("run", None)
        self.assertEqual(raised.exception.code, "capability_unimplemented")
        await harness.dispose()

    async def test_kv_quota_and_artifact_revision(self) -> None:
        host = MemoryHostClient()
        with self.assertRaises(PluginSdkError) as raised:
            await host.call("storage.kv", "put", {"key": "big", "value": "x" * (256 * 1024 + 1)})
        self.assertEqual(raised.exception.code, "kv_quota_exceeded")
        await host.call("artifact", "writeText", {"content": "a", "expectedRevision": "sha256:test-0"})
        with self.assertRaises(PluginSdkError) as conflict:
            await host.call(
                "artifact",
                "writeText",
                {"content": "b", "expectedRevision": "sha256:test-0"},
            )
        self.assertEqual(conflict.exception.code, "artifact_revision_conflict")

    async def test_database_rejects_attach_and_multi_statement(self) -> None:
        host = MemoryHostClient()
        with self.assertRaises(PluginSdkError) as denied:
            await host.call("storage.database", "execute", {"sql": "ATTACH 'x' AS other"})
        self.assertEqual(denied.exception.code, "db_sql_denied")
        with self.assertRaises(PluginSdkError) as multi:
            await host.call(
                "storage.database",
                "execute",
                {"sql": "CREATE TABLE a (id INT); CREATE TABLE b (id INT)"},
            )
        self.assertEqual(multi.exception.code, "db_sql_denied")


if __name__ == "__main__":
    unittest.main()
