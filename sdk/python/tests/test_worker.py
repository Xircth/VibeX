from __future__ import annotations

import asyncio
import unittest

from vibex_plugin import PluginSdkError, define_plugin_worker
from vibex_plugin.testing import create_generation_harness, create_worker_harness


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_registers_handlers_and_disposes_in_reverse(self) -> None:
        order: list[str] = []

        def setup(registrar, _environment) -> None:
            registrar.handle("document.preview", lambda value, _env: {"received": value})
            registrar.handle("surface.createSession", lambda _value, _env: {"ready": True})
            registrar.on_dispose(lambda: order.append("first"))
            registrar.on_dispose(lambda: order.append("second"))

        harness = await create_worker_harness(define_plugin_worker(setup))
        self.assertEqual(
            await harness.invoke("document.preview", {"path": "example.docx"}),
            {"received": {"path": "example.docx"}},
        )
        self.assertEqual(harness.handlers, ["document.preview", "surface.createSession"])
        await harness.dispose()
        self.assertEqual(order, ["second", "first"])

    async def test_rejects_duplicate_handlers(self) -> None:
        def setup(registrar, _environment) -> None:
            registrar.handle("document.preview", lambda _value, _env: None)
            registrar.handle("document.preview", lambda _value, _env: None)

        with self.assertRaises(PluginSdkError) as raised:
            await create_worker_harness(define_plugin_worker(setup))
        self.assertEqual(raised.exception.code, "handler_duplicate")

    async def test_rejects_invalid_handler_id(self) -> None:
        def setup(registrar, _environment) -> None:
            registrar.handle("Not Valid", lambda _value, _env: None)

        with self.assertRaises(PluginSdkError) as raised:
            await create_worker_harness(define_plugin_worker(setup))
        self.assertEqual(raised.exception.code, "handler_id_invalid")

    async def test_async_handler_and_setup(self) -> None:
        async def setup(registrar, environment) -> None:
            async def ping(_value, _env):
                await asyncio.sleep(0)
                return {"pluginId": environment.context["pluginId"]}

            registrar.handle("hello", ping)

        harness = await create_worker_harness(define_plugin_worker(setup))
        self.assertEqual(
            await harness.invoke("hello", None),
            {"pluginId": "dev.vibex.test"},
        )
        await harness.dispose()

    async def test_generation_harness_keeps_published_worker(self) -> None:
        first = define_plugin_worker(
            lambda registrar, _env: registrar.handle("value", lambda _v, _e: "published")
        )
        broken = define_plugin_worker(
            lambda registrar, _env: registrar.handle("other", lambda _v, _e: "candidate")
        )
        harness = await create_generation_harness(first, {"requiredHandlers": ["value"]})
        with self.assertRaises(PluginSdkError) as raised:
            await harness.activate_candidate(broken)
        self.assertEqual(raised.exception.code, "required_handler_missing")
        self.assertEqual(harness.generation, 1)
        self.assertEqual(await harness.invoke("value", None), "published")
        await harness.dispose()


if __name__ == "__main__":
    unittest.main()
