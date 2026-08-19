"""Host client and Full Trust filesystem / network helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from vibex_plugin.worker import JsonValue, PluginHostClient, PluginSdkError

__all__ = [
    "HostClient",
    "PluginHostClient",
    "fetch_url",
    "read_local_file",
    "write_local_file",
]


class HostClient(PluginHostClient):
    """Typed `environment.host` surface. `call` is the only Host RPC."""

    async def call(
        self,
        capability: str,
        operation: str,
        input: JsonValue = None,
    ) -> JsonValue:
        raise PluginSdkError(
            "capability_unimplemented",
            f"{capability}.{operation} has no host transport",
        )


def read_local_file(path: str | Path) -> bytes:
    """Read a local file. Isolated Workers must not import this helper."""
    target = Path(path)
    try:
        return target.read_bytes()
    except OSError as error:
        raise PluginSdkError("files_read_failed", str(error)) from error


def write_local_file(path: str | Path, data: bytes | str) -> None:
    """Write a local file. Isolated Workers must not import this helper."""
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            target.write_text(data, encoding="utf-8")
        else:
            target.write_bytes(data)
    except OSError as error:
        raise PluginSdkError("files_write_failed", str(error)) from error


def fetch_url(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | str | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Direct HTTP fetch. Isolated Workers must not import this helper."""
    payload: bytes | None
    if body is None:
        payload = None
    elif isinstance(body, bytes):
        payload = body
    else:
        payload = body.encode("utf-8")
    request = Request(url, data=payload, method=method.upper())
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 — Full Trust helper
            raw = response.read()
            response_headers = {key: value for key, value in response.headers.items()}
            return {
                "status": int(response.status),
                "headers": response_headers,
                "body": _decode_body(raw),
            }
    except HTTPError as error:
        raw = error.read()
        return {
            "status": int(error.code),
            "headers": {key: value for key, value in error.headers.items()},
            "body": _decode_body(raw),
        }
    except URLError as error:
        raise PluginSdkError("network_denied", str(error.reason)) from error


def _decode_body(raw: bytes) -> JsonValue:
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
