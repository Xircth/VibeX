"""Worker definition, registrar, environment, and PluginSdkError."""

from __future__ import annotations

import inspect
import re
from collections.abc import Callable
from typing import Any

PLUGIN_API_VERSION = "1.0"
PLUGIN_PROTOCOL_VERSION = "1.1"
PLUGIN_SDK_VERSION = "1.0.0"

HANDLER_ID = re.compile(r"^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$")

JsonValue = Any
PluginHandler = Callable[["JsonValue", "PluginWorkerEnvironment"], Any]


class PluginSdkError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        details: JsonValue | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def __repr__(self) -> str:
        return f"PluginSdkError({self.code!r}, {self.message!r})"


class Cancellation:
    def __init__(self) -> None:
        self._aborted = False

    @property
    def aborted(self) -> bool:
        return self._aborted

    def abort(self) -> None:
        self._aborted = True


class PluginLogger:
    def debug(self, message: str, fields: JsonValue | None = None) -> None:
        raise NotImplementedError

    def info(self, message: str, fields: JsonValue | None = None) -> None:
        raise NotImplementedError

    def warn(self, message: str, fields: JsonValue | None = None) -> None:
        raise NotImplementedError

    def error(self, message: str, fields: JsonValue | None = None) -> None:
        raise NotImplementedError


class PluginHostClient:
    async def call(
        self,
        capability: str,
        operation: str,
        input: JsonValue = None,
    ) -> JsonValue:
        raise NotImplementedError


class PluginContext(dict):
    @property
    def plugin_id(self) -> str:
        return str(self["pluginId"])

    @property
    def plugin_version(self) -> str:
        return str(self["pluginVersion"])

    @property
    def generation(self) -> int:
        return int(self["generation"])

    @property
    def package_class(self) -> str:
        return str(self["packageClass"])

    @property
    def granted_capabilities(self) -> list[str]:
        return list(self["grantedCapabilities"])


def normalize_plugin_context(context: dict[str, Any]) -> PluginContext:
    if "pluginId" not in context or "pluginVersion" not in context:
        raise PluginSdkError("protocol_invalid", "Plugin context is missing identity")
    if "generation" not in context:
        raise PluginSdkError("protocol_invalid", "Plugin context is missing generation")
    return PluginContext(
        {
            "pluginId": context["pluginId"],
            "pluginVersion": context["pluginVersion"],
            "generation": context["generation"],
            "packageClass": context.get("packageClass") or "full-trust",
            "grantedCapabilities": list(
                context.get("grantedCapabilities") or ["*"]
            ),
        }
    )


class PluginWorkerEnvironment:
    def __init__(
        self,
        context: PluginContext,
        host: PluginHostClient,
        log: PluginLogger,
        cancelled: Cancellation | None = None,
    ) -> None:
        self.context = context
        self.host = host
        self.log = log
        self.cancelled = cancelled or Cancellation()

    @property
    def signal(self) -> Cancellation:
        return self.cancelled


class PluginWorkerRegistrar:
    def __init__(self) -> None:
        self.handlers: dict[str, PluginHandler] = {}
        self.disposables: list[Any] = []

    def handle(self, id: str, handler: PluginHandler) -> None:
        validate_handler_id(id)
        if id in self.handlers:
            raise PluginSdkError(
                "handler_duplicate",
                f"Handler {id} is already registered",
            )
        self.handlers[id] = handler

    def on_dispose(self, disposable: Any) -> None:
        self.disposables.append(disposable)


class PluginWorkerDefinition:
    def __init__(self, setup: Callable[..., Any]) -> None:
        self.api_version = PLUGIN_API_VERSION
        self.setup = setup


class ActivatedPluginWorker:
    def __init__(
        self,
        handlers: dict[str, PluginHandler],
        disposables: list[Any],
        environment: PluginWorkerEnvironment,
    ) -> None:
        self._handlers = handlers
        self._disposables = disposables
        self.environment = environment
        self._disposed = False

    @property
    def handlers(self) -> list[str]:
        return sorted(self._handlers)

    async def invoke(self, handler: str, input: JsonValue = None) -> JsonValue:
        if self._disposed:
            raise PluginSdkError("worker_disposed", "Plugin worker is disposed")
        registered = self._handlers.get(handler)
        if registered is None:
            raise PluginSdkError(
                "handler_not_found",
                f"Handler {handler} is not registered",
            )
        return await invoke_maybe_async(registered, input, self.environment)

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        self.environment.cancelled.abort()
        errors: list[BaseException] = []
        for disposable in reversed(self._disposables):
            try:
                await dispose_one(disposable)
            except BaseException as error:  # noqa: BLE001 — collect all cleanup failures
                errors.append(error)
        self._handlers.clear()
        if errors:
            raise PluginSdkError(
                "worker_dispose_failed",
                "Plugin worker disposal failed",
                details=[error_payload(item) for item in errors],
            )


def define_plugin_worker(setup: Callable[..., Any]) -> PluginWorkerDefinition:
    return PluginWorkerDefinition(setup)


async def activate_plugin_worker(
    definition: PluginWorkerDefinition,
    *,
    context: dict[str, Any],
    host: PluginHostClient,
    log: PluginLogger,
) -> ActivatedPluginWorker:
    if definition.api_version != PLUGIN_API_VERSION:
        raise PluginSdkError(
            "sdk_incompatible",
            f"Unsupported worker API {definition.api_version}",
        )
    environment = PluginWorkerEnvironment(
        context=normalize_plugin_context(context),
        host=host,
        log=log,
    )
    registrar = PluginWorkerRegistrar()
    result = await invoke_maybe_async(definition.setup, registrar, environment)
    if result is not None:
        registrar.disposables.append(result)
    return ActivatedPluginWorker(
        handlers=registrar.handlers,
        disposables=registrar.disposables,
        environment=environment,
    )


def validate_handler_id(handler_id: str) -> None:
    if not HANDLER_ID.fullmatch(handler_id):
        raise PluginSdkError(
            "handler_id_invalid",
            f"Handler {handler_id} must be a namespaced lower-camel identifier",
        )


async def invoke_maybe_async(fn: Callable[..., Any], *args: Any) -> Any:
    result = fn(*args)
    if inspect.isawaitable(result):
        return await result
    return result


async def dispose_one(disposable: Any) -> None:
    if inspect.iscoroutinefunction(disposable):
        await disposable()
        return
    if callable(disposable) and not hasattr(disposable, "dispose"):
        result = disposable()
        if inspect.isawaitable(result):
            await result
        return
    dispose = getattr(disposable, "dispose", None)
    if dispose is None:
        return
    result = dispose()
    if inspect.isawaitable(result):
        await result


def error_payload(error: BaseException) -> dict[str, Any]:
    if isinstance(error, PluginSdkError):
        payload: dict[str, Any] = {"code": error.code, "message": error.message}
        if error.details is not None:
            payload["details"] = error.details
        return payload
    return {"code": "worker_failed", "message": str(error)}


def context_from_initialize(params: dict[str, Any]) -> dict[str, Any]:
    identity = params.get("pluginIdentity") or {}
    return {
        "pluginId": identity.get("id") or params.get("pluginId") or "",
        "pluginVersion": params.get("packageVersion") or params.get("pluginVersion") or "",
        "generation": params.get("generationId")
        if params.get("generationId") is not None
        else params.get("generation", 0),
        "packageClass": params.get("packageClass") or "full-trust",
        "grantedCapabilities": list(params.get("grantedCapabilities") or ["*"]),
    }
