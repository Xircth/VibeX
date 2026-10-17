"""Chunked stdio frames for plugin messages larger than one wire frame."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MIN_FRAME_BYTES = 1024 * 1024
MAX_FRAME_BYTES = 32 * 1024 * 1024
MAX_LOGICAL_MESSAGE_BYTES = 128 * 1024 * 1024
FRAME_CHUNK_METHOD = "frame.chunk"
_ENVELOPE_RESERVE = 192
_COUNT_PROBE = 99_999_999


class FrameError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class FrameLimits:
    max_frame_bytes: int = MAX_FRAME_BYTES
    max_logical_bytes: int = MAX_LOGICAL_MESSAGE_BYTES


def limits_from_advertised(
    max_frame_bytes: object,
    max_logical_bytes: object = None,
) -> FrameLimits:
    logical = MAX_LOGICAL_MESSAGE_BYTES if max_logical_bytes is None else max_logical_bytes
    if (
        isinstance(max_frame_bytes, bool)
        or not isinstance(max_frame_bytes, int)
        or isinstance(logical, bool)
        or not isinstance(logical, int)
        or not MIN_FRAME_BYTES <= max_frame_bytes <= MAX_LOGICAL_MESSAGE_BYTES
        or logical < max_frame_bytes
        or logical > MAX_LOGICAL_MESSAGE_BYTES
    ):
        raise FrameError(
            "protocol_invalid",
            "Host frame limits must stay from 1 MiB through 128 MiB",
        )
    return FrameLimits(max_frame_bytes=max_frame_bytes, max_logical_bytes=logical)


def _frame_for(stream_id: str, index: int, count: int, data: str) -> str:
    return json.dumps(
        {
            "id": f"chunk:{stream_id}:{index}",
            "method": FRAME_CHUNK_METHOD,
            "params": {
                "streamId": stream_id,
                "index": index,
                "count": count,
                "data": data,
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def encode_message(message: dict[str, Any], limits: FrameLimits | None = None) -> list[str]:
    limits = limits or FrameLimits()
    logical = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    logical_bytes = len(logical.encode("utf-8"))
    if logical_bytes > limits.max_logical_bytes:
        raise FrameError(
            "message_too_large",
            f"message is {logical_bytes} bytes; the limit is {limits.max_logical_bytes}",
        )
    if logical_bytes <= limits.max_frame_bytes:
        return [logical]
    stream_id = message.get("id")
    stream_id = stream_id if isinstance(stream_id, str) else "unknown"
    max_data = max(1, (limits.max_frame_bytes - _ENVELOPE_RESERVE) // 6)
    slices: list[str] = []
    offset = 0
    while offset < len(logical):
        take = min(len(logical) - offset, max_data)
        while True:
            data = logical[offset : offset + take]
            if not data:
                raise FrameError("frame_too_large", "frame limit is too small to encode a chunk")
            encoded = _frame_for(stream_id, len(slices), _COUNT_PROBE, data)
            if len(encoded.encode("utf-8")) <= limits.max_frame_bytes:
                break
            if len(data) <= 1:
                raise FrameError("frame_too_large", "frame limit is too small to encode a chunk")
            take = max(1, len(data) // 2)
        slices.append(data)
        offset += len(data)
    frames: list[str] = []
    for index, data in enumerate(slices):
        frame = _frame_for(stream_id, index, len(slices), data)
        if len(frame.encode("utf-8")) > limits.max_frame_bytes:
            raise FrameError("frame_too_large", "chunk frame exceeded the limit")
        frames.append(frame)
    return frames


class FrameReassembler:
    def __init__(self, limits: FrameLimits | None = None) -> None:
        self.limits = limits or FrameLimits()
        self._reset()

    def set_limits(self, limits: FrameLimits) -> None:
        if self._stream_id is None:
            self.limits = limits

    def push_line(self, line: str) -> dict[str, Any] | None:
        trimmed = line.strip()
        if not trimmed:
            return None
        if len(trimmed.encode("utf-8")) > self.limits.max_frame_bytes:
            self._reset()
            raise FrameError("frame_too_large", "Worker protocol frame exceeded the limit")
        try:
            value = json.loads(trimmed)
        except json.JSONDecodeError:
            self._reset()
            raise FrameError("protocol_invalid", "Invalid JSON message") from None
        if not isinstance(value, dict):
            self._reset()
            raise FrameError("protocol_invalid", "Protocol message must be an object")
        if value.get("method") != FRAME_CHUNK_METHOD:
            if self._stream_id is not None:
                self._reset()
                raise FrameError("frame_chunk_invalid", "Chunk sequence was interrupted")
            return value
        return self._push_chunk(value)

    def _push_chunk(self, value: dict[str, Any]) -> dict[str, Any] | None:
        params = value.get("params") if isinstance(value.get("params"), dict) else {}
        stream_id = params.get("streamId")
        index = params.get("index")
        count = params.get("count")
        data = params.get("data")
        if (
            not isinstance(stream_id, str)
            or not stream_id
            or not isinstance(data, str)
            or not data
            or not isinstance(index, int)
            or not isinstance(count, int)
            or isinstance(index, bool)
            or isinstance(count, bool)
            or count <= 0
            or index < 0
            or index >= count
        ):
            self._reset()
            raise FrameError("frame_chunk_invalid", "Chunk is missing streamId, index, count, or data")
        if index == 0:
            if self._stream_id is not None:
                self._reset()
                raise FrameError("frame_chunk_invalid", "Chunk sequence was interrupted")
            self._stream_id = stream_id
            self._count = count
            self._next_index = 0
            self._parts = []
            self._total_bytes = 0
        if self._stream_id != stream_id or index != self._next_index or count != self._count:
            self._reset()
            raise FrameError("frame_chunk_invalid", "Chunk index or count does not match the sequence")
        self._total_bytes += len(data.encode("utf-8"))
        if self._total_bytes > self.limits.max_logical_bytes:
            self._reset()
            raise FrameError(
                "message_too_large",
                f"message exceeds {self.limits.max_logical_bytes} bytes",
            )
        self._parts.append(data)
        self._next_index += 1
        if self._next_index < self._count:
            return None
        logical = "".join(self._parts)
        expected_id = stream_id
        self._reset()
        try:
            assembled = json.loads(logical)
        except json.JSONDecodeError:
            raise FrameError("protocol_invalid", "Reassembled message is not JSON") from None
        if not isinstance(assembled, dict) or assembled.get("id") != expected_id:
            raise FrameError(
                "frame_chunk_invalid",
                "Reassembled message id does not match the chunk stream",
            )
        return assembled

    def _reset(self) -> None:
        self._stream_id: str | None = None
        self._count = 0
        self._next_index = 0
        self._parts: list[str] = []
        self._total_bytes = 0
