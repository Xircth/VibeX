from __future__ import annotations

import asyncio
import unittest

from vibex_plugin import PluginSdkError, define_plugin_worker
from vibex_plugin.stdio import PluginWorkerSession


class StdioProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_activate_invoke_and_host_call(self) -> None:
        outbound: asyncio.Queue[dict] = asyncio.Queue()

        def setup(registrar, environment) -> None:
            async def echo(value, env):
                allowed = await env.host.call("storage", "kv.get", {"key": "n"})
                return {"value": value, "allowed": allowed}

            registrar.handle("echo.run", echo)

        session = PluginWorkerSession(define_plugin_worker(setup), outbound.put)
        await session.handle_message(
            {
                "id": "1",
                "method": "initialize",
                "params": {
                    "protocolRange": ["1.1"],
                    "hostVersion": "0.1.3",
                    "pluginIdentity": {"publisher": "vibex", "id": "echo"},
                    "packageVersion": "1.0.0",
                    "packageDigest": "sha256:test",
                    "generationId": 1,
                    "declaredContributions": ["echo.run"],
                    "packageClass": "full-trust",
                    "features": [],
                    "limits": {"maxFrameBytes": 1048576, "requestTimeoutMs": 30000},
                    "runtime": {
                        "id": "python",
                        "version": "3.12.11",
                        "target": "aarch64-apple-darwin",
                        "digest": "sha256:test",
                    },
                },
            }
        )
        initialized = await outbound.get()
        self.assertEqual(initialized["result"]["protocolVersion"], "1.1")
        self.assertEqual(initialized["result"]["sdkVersion"], "1.0.0")
        self.assertEqual(initialized["result"]["registrations"], ["echo.run"])

        await session.handle_message(
            {
                "id": "2",
                "method": "activate",
                "params": {
                    "pluginId": "echo",
                    "pluginVersion": "1.0.0",
                    "generation": 1,
                    "packageClass": "full-trust",
                    "grantedCapabilities": ["*"],
                },
            }
        )
        self.assertEqual((await outbound.get())["result"]["handlers"], ["echo.run"])

        invoke = asyncio.create_task(
            session.handle_message(
                {
                    "id": "3",
                    "method": "invoke",
                    "params": {"handler": "echo.run", "input": {"n": 1}},
                }
            )
        )
        host_call = await asyncio.wait_for(outbound.get(), timeout=2)
        self.assertEqual(host_call["method"], "host.call")
        await session.handle_message(
            {"id": host_call["id"], "ok": True, "result": {"present": True}}
        )
        await invoke
        result = await outbound.get()
        self.assertEqual(result, {"id": "3", "ok": True, "result": {"value": {"n": 1}, "allowed": {"present": True}}})

        await session.handle_message({"id": "4", "method": "ping", "params": {}})
        self.assertEqual((await outbound.get())["result"], {"apiVersion": "1.0"})
        await session.close()

    async def test_invoke_before_activate_is_inactive(self) -> None:
        outbound: asyncio.Queue[dict] = asyncio.Queue()
        session = PluginWorkerSession(
            define_plugin_worker(lambda registrar, _env: registrar.handle("hello", lambda v, _e: v)),
            outbound.put,
        )
        await session.handle_message(
            {"id": "1", "method": "invoke", "params": {"handler": "hello", "input": 1}}
        )
        response = await outbound.get()
        self.assertEqual(response["ok"], False)
        self.assertEqual(response["error"]["code"], "worker_inactive")
        await session.close()

    async def test_unsupported_protocol_range(self) -> None:
        outbound: asyncio.Queue[dict] = asyncio.Queue()
        session = PluginWorkerSession(
            define_plugin_worker(lambda registrar, _env: registrar.handle("hello", lambda v, _e: v)),
            outbound.put,
        )
        await session.handle_message(
            {
                "id": "1",
                "method": "initialize",
                "params": {"protocolRange": ["1.0"]},
            }
        )
        response = await outbound.get()
        self.assertEqual(response["error"]["code"], "protocol_unsupported")
        await session.close()

    async def test_isolated_exports_worker_not_fs_helpers(self) -> None:
        import vibex_plugin.isolated as isolated

        self.assertTrue(hasattr(isolated, "define_plugin_worker"))
        self.assertTrue(hasattr(isolated, "PluginSdkError"))
        self.assertFalse(hasattr(isolated, "read_local_file"))
        self.assertFalse(hasattr(isolated, "fetch_url"))
        self.assertIsInstance(PluginSdkError("x", "y"), Exception)


if __name__ == "__main__":
    unittest.main()
