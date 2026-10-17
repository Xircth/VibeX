from __future__ import annotations

import base64
import unittest

from vibex_plugin.blob import BLOB_CHUNK_BYTES, read_blob, write_blob
from vibex_plugin.worker import JsonValue, PluginHostClient


class MemoryBlobHost(PluginHostClient):
    def __init__(self) -> None:
        self.blobs: dict[str, bytearray] = {}
        self.appends: list[int] = []

    async def call(self, capability: str, operation: str, input: JsonValue = None) -> JsonValue:
        assert capability == "blob"
        body = input if isinstance(input, dict) else {}
        if operation == "create":
            self.blobs["abc"] = bytearray()
            return {"id": "abc"}
        blob = self.blobs["abc"]
        if operation == "append":
            chunk = base64.b64decode(str(body.get("data") or ""))
            assert len(chunk) <= BLOB_CHUNK_BYTES
            self.appends.append(len(chunk))
            blob.extend(chunk)
            return {"id": "abc", "byteLength": len(blob)}
        if operation == "finish":
            return {
                "id": "abc",
                "byteLength": len(blob),
                "mediaType": "video/mp4",
                "name": "clip.mp4",
                "finished": True,
            }
        if operation == "read":
            offset = int(body.get("offset") or 0)
            length = int(body.get("length") or BLOB_CHUNK_BYTES)
            chunk = bytes(blob[offset : offset + length])
            return {"id": "abc", "data": base64.b64encode(chunk).decode("ascii"), "byteLength": len(blob)}
        raise AssertionError(operation)


class BlobTransferTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_roundtrips_in_chunks(self) -> None:
        host = MemoryBlobHost()
        video = bytes([7]) * (BLOB_CHUNK_BYTES + 2)
        saved = await write_blob(host, video, media_type="video/mp4", name="clip.mp4")
        self.assertEqual(saved["byteLength"], len(video))
        self.assertEqual(host.appends, [BLOB_CHUNK_BYTES, 2])
        self.assertEqual(await read_blob(host, "abc"), video)


if __name__ == "__main__":
    unittest.main()
