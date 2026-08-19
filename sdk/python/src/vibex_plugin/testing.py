"""In-memory Host harness for plugin Worker unit tests.

Fidelity gap versus a real VibeX Host:
- storage.database is sqlite3 :memory:, not the Host-owned plugin data file.
- artifact.preview leases are tokens only; no TCP port or capability process.
- plugin.self.doctor reports harness state, not Host-persisted crashes or probes.
- runtime.execute, network.fetch, files.*, conversation.*, events.*,
  app.notify, and agent.invoke always fail with capability_unimplemented.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from typing import Any

from vibex_plugin.worker import (
    ActivatedPluginWorker,
    JsonValue,
    PluginHostClient,
    PluginLogger,
    PluginSdkError,
    PluginWorkerDefinition,
    activate_plugin_worker,
)

KV_VALUE_LIMIT = 256 * 1024
KV_TOTAL_LIMIT = 32 * 1024 * 1024
ARTIFACT_TEXT_LIMIT = 16 * 1024 * 1024
LOG_LIMIT = 16 * 1024
SQLITE_SIZE_LIMIT = 256 * 1024 * 1024

REDACT_KEYS = re.compile(
    r"(token|authorization|secret|password|VIBEX_SERVER_TOKEN|VIBEX_PLUGIN_DEV_GRANT)",
    re.IGNORECASE,
)
BEARER = re.compile(r"Bearer\s+\S+", re.IGNORECASE)

IMPLEMENTED = {
    "storage.settings.get",
    "storage.settings.put",
    "storage.kv.get",
    "storage.kv.put",
    "storage.kv.delete",
    "storage.kv.list",
    "storage.database.execute",
    "storage.database.query",
    "secrets.get",
    "secrets.put",
    "secrets.delete",
    "log.debug",
    "log.info",
    "log.warn",
    "log.error",
    "artifact.preview.open",
    "artifact.preview.close",
    "artifact.readText",
    "artifact.writeText",
    "plugin.self.doctor",
}


class NullLogger(PluginLogger):
    def debug(self, message: str, fields: JsonValue | None = None) -> None:
        return None

    def info(self, message: str, fields: JsonValue | None = None) -> None:
        return None

    def warn(self, message: str, fields: JsonValue | None = None) -> None:
        return None

    def error(self, message: str, fields: JsonValue | None = None) -> None:
        return None


class MemoryHostClient(PluginHostClient):
    def __init__(self) -> None:
        self.calls: list[dict[str, JsonValue]] = []
        self.settings: dict[str, JsonValue] = {}
        self.kv: dict[str, JsonValue] = {}
        self.secrets: dict[str, str] = {}
        self.logs: list[dict[str, JsonValue]] = []
        self.leases: dict[str, dict[str, JsonValue]] = {}
        self.artifact = {
            "name": "memory.txt",
            "content": "",
            "revision": "sha256:test-0",
        }
        self._artifact_revision = 0
        self._db = sqlite3.connect(":memory:")
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")

    async def call(
        self,
        capability: str,
        operation: str,
        input: JsonValue = None,
    ) -> JsonValue:
        self.calls.append(
            {"capability": capability, "operation": operation, "input": input}
        )
        key = f"{capability}.{operation}"
        if key not in IMPLEMENTED:
            raise PluginSdkError(
                "capability_unimplemented",
                f"{key} is not implemented by the in-memory harness",
            )
        handler = {
            "storage.settings.get": self._settings_get,
            "storage.settings.put": self._settings_put,
            "storage.kv.get": self._kv_get,
            "storage.kv.put": self._kv_put,
            "storage.kv.delete": self._kv_delete,
            "storage.kv.list": self._kv_list,
            "storage.database.execute": lambda value: self._db_run(value, query=False),
            "storage.database.query": lambda value: self._db_run(value, query=True),
            "secrets.get": self._secrets_get,
            "secrets.put": self._secrets_put,
            "secrets.delete": self._secrets_delete,
            "log.debug": lambda value: self._log("debug", value),
            "log.info": lambda value: self._log("info", value),
            "log.warn": lambda value: self._log("warn", value),
            "log.error": lambda value: self._log("error", value),
            "artifact.preview.open": self._preview_open,
            "artifact.preview.close": self._preview_close,
            "artifact.readText": self._artifact_read,
            "artifact.writeText": self._artifact_write,
            "plugin.self.doctor": self._doctor,
        }[key]
        return handler(input)

    def _settings_get(self, _input: JsonValue) -> JsonValue:
        return dict(self.settings)

    def _settings_put(self, input: JsonValue) -> JsonValue:
        value = _object_payload(input, "value")
        if not isinstance(value, dict):
            raise PluginSdkError("config_schema_invalid", "settings.put requires an object")
        self.settings = dict(value)
        return dict(self.settings)

    def _kv_get(self, input: JsonValue) -> JsonValue:
        key = _required_string(input, "key")
        return self.kv.get(key)

    def _kv_put(self, input: JsonValue) -> JsonValue:
        key = _required_string(input, "key")
        value = None if not isinstance(input, dict) else input.get("value")
        encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
        if len(encoded) > KV_VALUE_LIMIT:
            raise PluginSdkError("kv_quota_exceeded", "KV value exceeds 256 KiB")
        previous = json.dumps(self.kv.get(key), ensure_ascii=False).encode("utf-8") if key in self.kv else b""
        total = self._kv_bytes() - len(previous) + len(encoded)
        if total > KV_TOTAL_LIMIT:
            raise PluginSdkError("kv_quota_exceeded", "KV store exceeds 32 MiB")
        self.kv[key] = value
        return value

    def _kv_delete(self, input: JsonValue) -> JsonValue:
        key = _required_string(input, "key")
        self.kv.pop(key, None)
        return None

    def _kv_list(self, _input: JsonValue) -> JsonValue:
        return sorted(self.kv)

    def _kv_bytes(self) -> int:
        return sum(
            len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
            for value in self.kv.values()
        )

    def _db_run(self, input: JsonValue, *, query: bool) -> JsonValue:
        if not isinstance(input, dict):
            raise PluginSdkError("db_sql_denied", "database calls require {sql, params}")
        sql = str(input.get("sql") or "").strip()
        params = input.get("params") or []
        if not sql:
            raise PluginSdkError("db_sql_denied", "sql is required")
        if not isinstance(params, list):
            raise PluginSdkError("db_sql_denied", "params must be an array")
        statement = _single_sql(sql)
        try:
            cursor = self._db.execute(statement, params)
            rows = []
            if query or cursor.description:
                rows = [dict(row) for row in cursor.fetchall()]
            self._db.commit()
            page = self._db.execute("PRAGMA page_count").fetchone()[0]
            size = self._db.execute("PRAGMA page_size").fetchone()[0]
            if int(page) * int(size) > SQLITE_SIZE_LIMIT:
                raise PluginSdkError("kv_quota_exceeded", "SQLite database exceeds 256 MiB")
            return {"rows": rows, "changes": int(cursor.rowcount if cursor.rowcount != -1 else 0)}
        except PluginSdkError:
            raise
        except sqlite3.Error as error:
            raise PluginSdkError("db_sql_denied", str(error)) from error

    def _secrets_get(self, input: JsonValue) -> JsonValue:
        name = _required_string(input, "name")
        if name not in self.secrets:
            return {"present": False}
        return {"present": True, "value": self.secrets[name]}

    def _secrets_put(self, input: JsonValue) -> JsonValue:
        name = _required_string(input, "name")
        value = "" if not isinstance(input, dict) else str(input.get("value") or "")
        self.secrets[name] = value
        return {"present": True}

    def _secrets_delete(self, input: JsonValue) -> JsonValue:
        name = _required_string(input, "name")
        self.secrets.pop(name, None)
        return {"present": False}

    def _log(self, level: str, input: JsonValue) -> JsonValue:
        payload = input if isinstance(input, dict) else {"message": input}
        message = str(payload.get("message") or "")
        if len(message) > LOG_LIMIT:
            message = message[:LOG_LIMIT]
        fields = redact(payload.get("fields"))
        self.logs.append({"level": level, "message": message, "fields": fields})
        return {}

    def _preview_open(self, input: JsonValue) -> JsonValue:
        if not isinstance(input, dict) or not input.get("artifactHandle"):
            raise PluginSdkError("artifact_handle_invalid", "artifactHandle is required")
        lease_id = str(uuid.uuid4())
        lease = {
            "leaseId": lease_id,
            "port": 0,
            "capabilityToken": f"test-token-{lease_id}",
            "expiresAtUnixMs": int(time.time() * 1000) + 300_000,
            "providerId": input.get("providerId"),
            "artifactHandle": input.get("artifactHandle"),
        }
        self.leases[lease_id] = lease
        return {
            "leaseId": lease_id,
            "port": 0,
            "capabilityToken": lease["capabilityToken"],
            "expiresAtUnixMs": lease["expiresAtUnixMs"],
        }

    def _preview_close(self, input: JsonValue) -> JsonValue:
        lease_id = _required_string(input, "leaseId")
        if lease_id not in self.leases:
            raise PluginSdkError("preview_not_open", "Preview lease is not open")
        del self.leases[lease_id]
        return {}

    def _artifact_read(self, input: JsonValue) -> JsonValue:
        if isinstance(input, dict) and input.get("artifactId"):
            if str(input["artifactId"]) not in {"memory", self.artifact.get("name"), "memory.txt"}:
                raise PluginSdkError("artifact_not_found", "Artifact was not found")
        return dict(self.artifact)

    def _artifact_write(self, input: JsonValue) -> JsonValue:
        if not isinstance(input, dict):
            raise PluginSdkError("artifact_revision_conflict", "writeText requires content and revision")
        content = str(input.get("content") or "")
        if len(content.encode("utf-8")) > ARTIFACT_TEXT_LIMIT:
            raise PluginSdkError("network_body_too_large", "Artifact text exceeds 16 MiB")
        expected = input.get("expectedRevision")
        if expected is not None and expected != self.artifact["revision"]:
            raise PluginSdkError(
                "artifact_revision_conflict",
                "The artifact changed outside this editor",
            )
        self._artifact_revision += 1
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        self.artifact = {
            "name": self.artifact["name"],
            "content": content,
            "revision": f"sha256:{digest[:16]}-{self._artifact_revision}",
        }
        return {"revision": self.artifact["revision"]}

    def _doctor(self, _input: JsonValue) -> JsonValue:
        return {
            "pluginId": "dev.vibex.test",
            "diagnostics": [],
            "recentCrashes": [],
            "implemented": sorted(IMPLEMENTED),
            "logs": list(self.logs),
            "directNetworkPossible": True,
        }


class RecordingLogger(PluginLogger):
    def __init__(self, host: MemoryHostClient) -> None:
        self._host = host

    def debug(self, message: str, fields: JsonValue | None = None) -> None:
        self._host.logs.append({"level": "debug", "message": message, "fields": fields})

    def info(self, message: str, fields: JsonValue | None = None) -> None:
        self._host.logs.append({"level": "info", "message": message, "fields": fields})

    def warn(self, message: str, fields: JsonValue | None = None) -> None:
        self._host.logs.append({"level": "warn", "message": message, "fields": fields})

    def error(self, message: str, fields: JsonValue | None = None) -> None:
        self._host.logs.append({"level": "error", "message": message, "fields": fields})


class WorkerHarness:
    def __init__(self, worker: ActivatedPluginWorker, host: MemoryHostClient | PluginHostClient) -> None:
        self._worker = worker
        self.host = host

    @property
    def handlers(self) -> list[str]:
        return self._worker.handlers

    @property
    def host_calls(self) -> list[dict[str, JsonValue]]:
        if isinstance(self.host, MemoryHostClient):
            return list(self.host.calls)
        return []

    @property
    def environment(self):
        return self._worker.environment

    async def invoke(self, handler: str, input: JsonValue = None) -> JsonValue:
        return await self._worker.invoke(handler, input)

    async def dispose(self) -> None:
        await self._worker.dispose()


async def create_worker_harness(
    definition: PluginWorkerDefinition,
    options: dict[str, Any] | None = None,
) -> WorkerHarness:
    options = options or {}
    host = options.get("host") or MemoryHostClient()
    context = options.get("context") or {}
    worker = await activate_plugin_worker(
        definition,
        context={
            "pluginId": context.get("pluginId") or "dev.vibex.test",
            "pluginVersion": context.get("pluginVersion") or "0.0.0-test",
            "generation": context.get("generation") if context.get("generation") is not None else 1,
            "packageClass": context.get("packageClass") or "full-trust",
            "grantedCapabilities": list(context.get("grantedCapabilities") or ["*"]),
        },
        host=host,
        log=RecordingLogger(host) if isinstance(host, MemoryHostClient) else NullLogger(),
    )
    return WorkerHarness(worker, host)


class GenerationHarness:
    def __init__(
        self,
        active: WorkerHarness,
        definition: PluginWorkerDefinition,
        options: dict[str, Any],
        generation: int,
    ) -> None:
        self._active = active
        self._definition = definition
        self._options = options
        self.generation = generation

    @property
    def handlers(self) -> list[str]:
        return self._active.handlers

    async def invoke(self, handler: str, input: JsonValue = None) -> JsonValue:
        return await self._active.invoke(handler, input)

    async def activate_candidate(self, definition: PluginWorkerDefinition) -> int:
        candidate_generation = self.generation + 1
        candidate = await create_worker_harness(
            definition,
            {
                "context": {
                    **(self._options.get("context") or {}),
                    "generation": candidate_generation,
                },
                "host": self._options.get("host"),
            },
        )
        try:
            _assert_required(candidate, self._options.get("requiredHandlers"))
        except PluginSdkError:
            await candidate.dispose()
            raise
        previous = self._active
        self._active = candidate
        self.generation = candidate_generation
        await previous.dispose()
        return self.generation

    async def dispose(self) -> None:
        await self._active.dispose()


async def create_generation_harness(
    definition: PluginWorkerDefinition,
    options: dict[str, Any] | None = None,
) -> GenerationHarness:
    options = options or {}
    generation = (options.get("context") or {}).get("generation") or 1
    active = await create_worker_harness(
        definition,
        {
            "context": {**(options.get("context") or {}), "generation": generation},
            "host": options.get("host"),
        },
    )
    _assert_required(active, options.get("requiredHandlers"))
    return GenerationHarness(active, definition, options, generation)


def _assert_required(worker: WorkerHarness, required: list[str] | None) -> None:
    for handler in required or []:
        if handler not in worker.handlers:
            raise PluginSdkError(
                "required_handler_missing",
                f"Required handler {handler} is not registered",
            )


def _required_string(input: JsonValue, field: str) -> str:
    if not isinstance(input, dict) or input.get(field) in (None, ""):
        raise PluginSdkError("protocol_invalid", f"{field} is required")
    return str(input[field])


def _object_payload(input: JsonValue, wrapped: str) -> JsonValue:
    if isinstance(input, dict) and wrapped in input and isinstance(input[wrapped], dict):
        return input[wrapped]
    return input


def _single_sql(sql: str) -> str:
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        raise PluginSdkError("db_sql_denied", "sql is required")
    if ";" in stripped:
        raise PluginSdkError("db_sql_denied", "SQL must be a single statement")
    leading = stripped.lstrip().split(None, 1)[0].upper()
    if leading in {"ATTACH", "PRAGMA"}:
        raise PluginSdkError("db_sql_denied", "ATTACH and PRAGMA are not allowed")
    return stripped


def redact(value: JsonValue) -> JsonValue:
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if REDACT_KEYS.search(str(key)):
                redacted[key] = "[redacted]"
            else:
                redacted[key] = redact(item)
        return redacted
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return BEARER.sub("Bearer [redacted]", value)
    return value
