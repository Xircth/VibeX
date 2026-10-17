"""Disk blobs for video and other bytes that do not fit in one JSON message."""

from __future__ import annotations

import base64
from typing import Any

from vibex_plugin.worker import PluginHostClient

BLOB_CHUNK_BYTES = 512 * 1024
BLOB_MAX_BYTES = 4 * 1024 * 1024 * 1024


async def write_blob(
    host: PluginHostClient,
    data: bytes,
    *,
    media_type: str = "application/octet-stream",
    name: str | None = None,
) -> dict[str, Any]:
    created = await host.call(
        "blob",
        "create",
        {"mediaType": media_type, "name": name},
    )
    blob_id = str(created["id"])
    for offset in range(0, len(data), BLOB_CHUNK_BYTES):
        chunk = data[offset : offset + BLOB_CHUNK_BYTES]
        await host.call(
            "blob",
            "append",
            {"id": blob_id, "data": base64.b64encode(chunk).decode("ascii")},
        )
    finished = await host.call("blob", "finish", {"id": blob_id})
    return finished if isinstance(finished, dict) else {"id": blob_id}


async def read_blob(host: PluginHostClient, blob_id: str) -> bytes:
    parts: list[bytes] = []
    offset = 0
    byte_length = 0
    while True:
        page = await host.call(
            "blob",
            "read",
            {"id": blob_id, "offset": offset, "length": BLOB_CHUNK_BYTES},
        )
        if not isinstance(page, dict):
            break
        byte_length = int(page.get("byteLength") or 0)
        chunk = base64.b64decode(str(page.get("data") or ""))
        if not chunk:
            break
        parts.append(chunk)
        offset += len(chunk)
        if offset >= byte_length:
            break
    return b"".join(parts)
