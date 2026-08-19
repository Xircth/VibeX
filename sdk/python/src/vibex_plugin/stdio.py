"""Asyncio stdio loop for plugin protocol 1.1."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from vibex_plugin.worker import (
    PLUGIN_API_VERSION,
    PLUGIN_PROTOCOL_VERSION,
    PLUGIN_SDK_VERSION,
    ActivatedPluginWorker,
    JsonValue,
    PluginHostClient,
    PluginLogger,
    PluginSdkError,
    PluginWorkerDefinition,
    activate_plugin_worker,
    context_from_initialize,
    error_payload,
)

MAX_FRAME_BYTES = 1_048_576


class StderrLogger(PluginLogger):
    def debug(self, message: str, fields: JsonValue | None = None) -> None:
        _write_stderr("debug", message, fields)

    def info(self, message: str, fields: JsonValue | None = None) -> None:
        _write_stderr("info", message, fields)

    def warn(self, message: str, fields: JsonValue | None = None) -> None:
        _write_stderr("warn", message, fields)

    def error(self, message: str, fields: JsonValue | None = None) -> None:
        _write_stderr("error", message, fields)


def _write_stderr(level: str, message: str, fields: JsonValue | None) -> None:
    line = json.dumps(
        {"level": level, "message": message, "fields": fields},
        ensure_ascii=False,
    )
    sys.stderr.buffer.write((line + "\n").encode("utf-8"))
    sys.stderr.buffer.flush()


class StdioHostClient(PluginHostClient):
    def __init__(self, session: "PluginWorkerSession") -> None:
        self._session = session

    async def call(
        self,
        capability: str,
        operation: str,
        input: JsonValue = None,
    ) -> JsonValue:
        return await self._session.host_call(capability, operation, input)


class PluginWorkerSession:
    """In-process protocol 1.1 session used by stdio and fixture replay."""

    def __init__(
        self,
        definition: PluginWorkerDefinition,
        send: Callable[[dict[str, Any]], Awaitable[None] | None],
    ) -> None:
        self._definition = definition
        self._send = send
        self._worker: ActivatedPluginWorker | None = None
        self._initialized = False
        self._host_sequence = 0
        self._host_pending: dict[str, asyncio.Future[JsonValue]] = {}
        self._in_flight: set[asyncio.Task[None]] = set()
        self._current_request_id = "unknown"
        self.host = StdioHostClient(self)
        self.log = StderrLogger()

    async def emit(self, message: dict[str, Any]) -> None:
        result = self._send(message)
        if asyncio.iscoroutine(result) or asyncio.isfuture(result):
            await result

    async def host_call(
        self,
        capability: str,
        operation: str,
        input: JsonValue,
    ) -> JsonValue:
        self._host_sequence += 1
        request_id = f"host:{self._host_sequence}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[JsonValue] = loop.create_future()
        self._host_pending[request_id] = future
        await self.emit(
            {
                "id": request_id,
                "method": "host.call",
                "params": {
                    "capability": capability,
                    "operation": operation,
                    "input": input,
                },
            }
        )
        return await future

    async def handle_message(self, message: dict[str, Any]) -> None:
        if "ok" in message and message.get("id") in self._host_pending:
            pending = self._host_pending.pop(message["id"])
            if message.get("ok"):
                pending.set_result(message.get("result"))
            else:
                error = message.get("error") or {}
                pending.set_exception(
                    PluginSdkError(
                        str(error.get("code") or "host_failed"),
                        str(error.get("message") or "Host request failed"),
                        error.get("details"),
                    )
                )
            return

        request_id = str(message.get("id") or "unknown")
        self._current_request_id = request_id
        method = message.get("method")
        if not method:
            await self.emit(
                error_response(request_id, "protocol_invalid", "Unknown protocol message")
            )
            return
        try:
            await self._dispatch(request_id, str(method), message.get("params") or {})
        except PluginSdkError as error:
            await self.emit(error_response(request_id, error.code, error.message, error.details))
        except Exception as error:  # noqa: BLE001 — protocol boundary
            await self.emit(error_response(request_id, "worker_failed", str(error)))

    async def handle_line(self, line: str) -> None:
        stripped = line.strip()
        if not stripped:
            return
        if len(stripped.encode("utf-8")) > MAX_FRAME_BYTES:
            await self.emit(
                error_response("unknown", "worker_frame_too_large", "Worker protocol frame exceeded the limit")
            )
            return
        try:
            message = json.loads(stripped)
        except json.JSONDecodeError:
            await self.emit(
                error_response("unknown", "protocol_invalid", "Invalid JSON message")
            )
            return
        if not isinstance(message, dict):
            await self.emit(
                error_response("unknown", "protocol_invalid", "Protocol message must be an object")
            )
            return
        await self.handle_message(message)

    async def _dispatch(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        if method == "initialize":
            await self._initialize(request_id, params)
            return
        if method == "activate":
            await self._activate(request_id, params)
            return
        if method == "invoke":
            await self._invoke(request_id, params)
            return
        if method == "dispose":
            await self.dispose()
            await self.emit({"id": request_id, "ok": True, "result": None})
            return
        if method == "ping":
            await self.emit(
                {"id": request_id, "ok": True, "result": {"apiVersion": PLUGIN_API_VERSION}}
            )
            return
        raise PluginSdkError("protocol_invalid", f"Unknown method {method}")

    async def _initialize(self, request_id: str, params: dict[str, Any]) -> None:
        protocol_range = params.get("protocolRange") or []
        if PLUGIN_PROTOCOL_VERSION not in protocol_range:
            raise PluginSdkError(
                "protocol_unsupported",
                "Host protocol range does not include 1.1",
            )
        if self._worker is None:
            self._worker = await activate_plugin_worker(
                self._definition,
                context=context_from_initialize(params),
                host=self.host,
                log=self.log,
            )
        self._initialized = True
        await self.emit(
            {
                "id": request_id,
                "ok": True,
                "result": {
                    "protocolVersion": PLUGIN_PROTOCOL_VERSION,
                    "sdkVersion": PLUGIN_SDK_VERSION,
                    "registrations": list(self._worker.handlers),
                    "requestedFeatures": [],
                },
            }
        )

    async def _activate(self, request_id: str, params: dict[str, Any]) -> None:
        if self._worker is not None and _is_active(self._worker):
            raise PluginSdkError("worker_active", "Plugin worker is already active")
        if self._worker is None:
            self._worker = await activate_plugin_worker(
                self._definition,
                context=params,
                host=self.host,
                log=self.log,
            )
        else:
            self._worker.environment.context = type(self._worker.environment.context)(
                {
                    "pluginId": params.get("pluginId")
                    or self._worker.environment.context["pluginId"],
                    "pluginVersion": params.get("pluginVersion")
                    or self._worker.environment.context["pluginVersion"],
                    "generation": params.get("generation")
                    if params.get("generation") is not None
                    else self._worker.environment.context["generation"],
                    "packageClass": params.get("packageClass")
                    or self._worker.environment.context["packageClass"],
                    "grantedCapabilities": list(
                        params.get("grantedCapabilities")
                        or self._worker.environment.context["grantedCapabilities"]
                    ),
                }
            )
        self._worker.environment.cancelled._aborted = False
        setattr(self._worker, "_session_active", True)
        await self.emit(
            {
                "id": request_id,
                "ok": True,
                "result": {"handlers": list(self._worker.handlers)},
            }
        )

    async def _invoke(self, request_id: str, params: dict[str, Any]) -> None:
        if self._worker is None or not _is_active(self._worker):
            raise PluginSdkError("worker_inactive", "Plugin worker is not active")
        worker = self._worker
        task = asyncio.create_task(self._run_invoke(worker, request_id, params))
        self._in_flight.add(task)
        task.add_done_callback(self._in_flight.discard)

    async def _run_invoke(
        self,
        worker: ActivatedPluginWorker,
        request_id: str,
        params: dict[str, Any],
    ) -> None:
        try:
            result = await worker.invoke(params.get("handler") or "", params.get("input"))
            await self.emit({"id": request_id, "ok": True, "result": result})
        except PluginSdkError as error:
            await self.emit(error_response(request_id, error.code, error.message, error.details))
        except Exception as error:  # noqa: BLE001
            await self.emit(error_response(request_id, "worker_failed", str(error)))

    async def dispose(self) -> None:
        if self._worker is not None:
            await self._worker.dispose()
            setattr(self._worker, "_session_active", False)
        for pending in self._host_pending.values():
            if not pending.done():
                pending.set_exception(
                    PluginSdkError("host_closed", "Host connection closed")
                )
        self._host_pending.clear()

    async def close(self) -> None:
        if self._in_flight:
            await asyncio.gather(*self._in_flight, return_exceptions=True)
        await self.dispose()


def _is_active(worker: ActivatedPluginWorker) -> bool:
    return bool(getattr(worker, "_session_active", False)) and not worker._disposed


def error_response(
    request_id: str,
    code: str,
    message: str,
    details: JsonValue | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {"id": request_id, "ok": False, "error": error}


def configure_binary_stdio() -> None:
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


async def run_stdio_plugin_worker_async(definition: PluginWorkerDefinition) -> None:
    configure_binary_stdio()
    write_lock = asyncio.Lock()

    async def send(message: dict[str, Any]) -> None:
        payload = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        if len(payload) > MAX_FRAME_BYTES:
            payload = (
                json.dumps(
                    error_response(
                        str(message.get("id") or "unknown"),
                        "worker_frame_too_large",
                        "Worker protocol frame exceeded the limit",
                    ),
                    ensure_ascii=False,
                )
                + "\n"
            ).encode("utf-8")
        async with write_lock:
            await asyncio.to_thread(_write_stdout, payload)

    session = PluginWorkerSession(definition, send)
    loop = asyncio.get_running_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, sys.stdin.buffer.readline)
            if not line:
                break
            try:
                text = line.decode("utf-8")
            except UnicodeDecodeError:
                await session.emit(
                    error_response("unknown", "protocol_invalid", "Invalid UTF-8 message")
                )
                continue
            if text.endswith("\r\n"):
                text = text[:-2] + "\n"
            await session.handle_line(text)
    finally:
        await session.close()


def _write_stdout(payload: bytes) -> None:
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def run_stdio_plugin_worker(definition: PluginWorkerDefinition) -> None:
    asyncio.run(run_stdio_plugin_worker_async(definition))
