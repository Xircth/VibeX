export const VIBEX_PLUGIN_API_VERSION = "1.0";
export const VIBEX_PLUGIN_PROTOCOL_VERSION = "1.1";
export const MIN_FRAME_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_LOGICAL_MESSAGE_BYTES = 128 * 1024 * 1024;
export const FRAME_CHUNK_METHOD = "frame.chunk";
const ENVELOPE_RESERVE = 192;
const COUNT_PROBE = 99999999;
export class ProtocolFrameError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ProtocolFrameError";
        this.code = code;
    }
}
export function protocolFrameLimits() {
    return {
        maxFrameBytes: MAX_FRAME_BYTES,
        maxLogicalBytes: MAX_LOGICAL_MESSAGE_BYTES,
    };
}
/** Limits the Host advertised in initialize. Frame stays inside 1 MiB..=128 MiB. */
export function frameLimitsFromAdvertised(maxFrameBytes, maxLogicalMessageBytes) {
    const maxLogicalBytes = maxLogicalMessageBytes ?? MAX_LOGICAL_MESSAGE_BYTES;
    if (!Number.isInteger(maxFrameBytes) ||
        maxFrameBytes < MIN_FRAME_BYTES ||
        maxFrameBytes > MAX_LOGICAL_MESSAGE_BYTES ||
        !Number.isInteger(maxLogicalBytes) ||
        maxLogicalBytes < maxFrameBytes ||
        maxLogicalBytes > MAX_LOGICAL_MESSAGE_BYTES) {
        throw new ProtocolFrameError("protocol_invalid", "Host frame limits must stay from 1 MiB through 128 MiB");
    }
    return { maxFrameBytes, maxLogicalBytes };
}
function frameFor(streamId, index, count, data) {
    return JSON.stringify({
        id: `chunk:${streamId}:${index}`,
        method: FRAME_CHUNK_METHOD,
        params: { streamId, index, count, data },
    });
}
function safeSlice(text, start, take) {
    let end = Math.min(text.length, start + take);
    if (end < text.length) {
        const tail = text.charCodeAt(end - 1);
        if (tail >= 0xd800 && tail <= 0xdbff)
            end -= 1;
    }
    if (end <= start)
        return "";
    return text.slice(start, end);
}
/** One JSON line when the message fits. Larger payloads become frame.chunk. */
export function encodeProtocolMessage(message, limits = protocolFrameLimits()) {
    const logical = JSON.stringify(message);
    const logicalBytes = Buffer.byteLength(logical, "utf8");
    if (logicalBytes > limits.maxLogicalBytes) {
        throw new ProtocolFrameError("message_too_large", `message is ${logicalBytes} bytes; the limit is ${limits.maxLogicalBytes}`);
    }
    if (logicalBytes <= limits.maxFrameBytes)
        return [logical];
    const streamId = typeof message.id === "string" ? message.id : "unknown";
    let maxData = Math.floor((limits.maxFrameBytes - ENVELOPE_RESERVE) / 6);
    if (maxData < 1)
        maxData = 1;
    const slices = [];
    let offset = 0;
    while (offset < logical.length) {
        let take = Math.min(logical.length - offset, maxData);
        let data = "";
        let encoded = "";
        for (;;) {
            data = safeSlice(logical, offset, take);
            if (!data) {
                throw new ProtocolFrameError("frame_too_large", "frame limit is too small to encode a chunk");
            }
            encoded = frameFor(streamId, slices.length, COUNT_PROBE, data);
            if (Buffer.byteLength(encoded, "utf8") <= limits.maxFrameBytes)
                break;
            if (data.length <= 1) {
                throw new ProtocolFrameError("frame_too_large", "frame limit is too small to encode a chunk");
            }
            take = Math.max(1, Math.floor(data.length / 2));
        }
        slices.push(data);
        offset += data.length;
    }
    return slices.map((data, index) => {
        const frame = frameFor(streamId, index, slices.length, data);
        if (Buffer.byteLength(frame, "utf8") > limits.maxFrameBytes) {
            throw new ProtocolFrameError("frame_too_large", "chunk frame exceeded the limit");
        }
        return frame;
    });
}
export class FrameReassembler {
    limits;
    streamId = null;
    count = 0;
    nextIndex = 0;
    parts = [];
    totalBytes = 0;
    constructor(limits = protocolFrameLimits()) {
        this.limits = limits;
    }
    setLimits(limits) {
        if (this.streamId === null)
            this.limits = limits;
    }
    pushLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return { kind: "skip" };
        if (Buffer.byteLength(trimmed, "utf8") > this.limits.maxFrameBytes) {
            this.reset();
            throw new ProtocolFrameError("frame_too_large", "Worker protocol frame exceeded the limit");
        }
        let value;
        try {
            value = JSON.parse(trimmed);
        }
        catch {
            this.reset();
            throw new ProtocolFrameError("protocol_invalid", "Invalid JSON message");
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            this.reset();
            throw new ProtocolFrameError("protocol_invalid", "Protocol message must be an object");
        }
        const message = value;
        if (message.method !== FRAME_CHUNK_METHOD) {
            if (this.streamId !== null) {
                this.reset();
                throw new ProtocolFrameError("frame_chunk_invalid", "Chunk sequence was interrupted");
            }
            return { kind: "message", message };
        }
        return this.pushChunk(message);
    }
    pushChunk(message) {
        const params = message.params && typeof message.params === "object"
            ? message.params
            : {};
        const streamId = typeof params.streamId === "string" ? params.streamId : "";
        const index = typeof params.index === "number" ? params.index : Number.NaN;
        const count = typeof params.count === "number" ? params.count : Number.NaN;
        const data = typeof params.data === "string" ? params.data : "";
        if (!streamId ||
            !data ||
            !Number.isInteger(index) ||
            !Number.isInteger(count) ||
            count <= 0 ||
            index < 0 ||
            index >= count) {
            this.reset();
            throw new ProtocolFrameError("frame_chunk_invalid", "Chunk is missing streamId, index, count, or data");
        }
        if (index === 0) {
            if (this.streamId !== null) {
                this.reset();
                throw new ProtocolFrameError("frame_chunk_invalid", "Chunk sequence was interrupted");
            }
            this.streamId = streamId;
            this.count = count;
            this.nextIndex = 0;
            this.parts = [];
            this.totalBytes = 0;
        }
        if (this.streamId !== streamId ||
            index !== this.nextIndex ||
            count !== this.count) {
            this.reset();
            throw new ProtocolFrameError("frame_chunk_invalid", "Chunk index or count does not match the sequence");
        }
        this.totalBytes += Buffer.byteLength(data, "utf8");
        if (this.totalBytes > this.limits.maxLogicalBytes) {
            this.reset();
            throw new ProtocolFrameError("message_too_large", `message exceeds ${this.limits.maxLogicalBytes} bytes`);
        }
        this.parts.push(data);
        this.nextIndex += 1;
        if (this.nextIndex < this.count)
            return { kind: "skip" };
        const logical = this.parts.join("");
        const expectedId = streamId;
        this.reset();
        let assembled;
        try {
            assembled = JSON.parse(logical);
        }
        catch {
            throw new ProtocolFrameError("protocol_invalid", "Reassembled message is not JSON");
        }
        if (!assembled ||
            typeof assembled !== "object" ||
            Array.isArray(assembled) ||
            assembled.id !== expectedId) {
            throw new ProtocolFrameError("frame_chunk_invalid", "Reassembled message id does not match the chunk stream");
        }
        return {
            kind: "message",
            message: assembled,
        };
    }
    reset() {
        this.streamId = null;
        this.count = 0;
        this.nextIndex = 0;
        this.parts = [];
        this.totalBytes = 0;
    }
}
