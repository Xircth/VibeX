export const VIBEX_PLUGIN_API_VERSION = "1.0" as const;
export const VIBEX_PLUGIN_PROTOCOL_VERSION = "1.1" as const;
export const MIN_FRAME_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_LOGICAL_MESSAGE_BYTES = 128 * 1024 * 1024;
export const FRAME_CHUNK_METHOD = "frame.chunk";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PackageClass = "full-trust" | "isolated";

export interface InitializeParams {
  protocolRange: ["1.1"];
  hostVersion: string;
  pluginIdentity: { publisher: string; id: string };
  packageVersion: string;
  packageDigest: string;
  generationId: number;
  declaredContributions: string[];
  packageClass: PackageClass;
  features: string[];
  limits: {
    maxFrameBytes: number;
    maxLogicalMessageBytes?: number;
    requestTimeoutMs: number;
  };
  runtime: { id: string; version: string; target: string; digest: string };
}

export interface InitializedResult {
  protocolVersion: "1.1";
  sdkVersion: string;
  registrations: string[];
  requestedFeatures: string[];
}

export interface PluginContext {
  pluginId: string;
  pluginVersion: string;
  generation: number;
  packageClass: PackageClass;
  grantedCapabilities: string[];
}

export type WorkerRequest =
  | { id: string; method: "initialize"; params: InitializeParams }
  | { id: string; method: "activate"; params: PluginContext }
  | {
      id: string;
      method: "invoke";
      params: { handler: string; input: JsonValue };
    }
  | { id: string; method: "dispose"; params: { reason: string } }
  | { id: string; method: "ping"; params: Record<string, never> };

export type WorkerResponse =
  | { id: string; ok: true; result: JsonValue }
  | {
      id: string;
      ok: false;
      error: { code: string; message: string; details?: JsonValue };
    };

export type HostRequest = {
  id: string;
  method: "host.call";
  params: {
    capability: string;
    operation: string;
    input: JsonValue;
  };
};

export type HostResponse = WorkerResponse;

const ENVELOPE_RESERVE = 192;
const COUNT_PROBE = 99999999;

export class ProtocolFrameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolFrameError";
    this.code = code;
  }
}

export interface FrameLimits {
  maxFrameBytes: number;
  maxLogicalBytes: number;
}

export function protocolFrameLimits(): FrameLimits {
  return {
    maxFrameBytes: MAX_FRAME_BYTES,
    maxLogicalBytes: MAX_LOGICAL_MESSAGE_BYTES,
  };
}

/** Limits the Host advertised in initialize. Frame stays inside 1 MiB..=128 MiB. */
export function frameLimitsFromAdvertised(
  maxFrameBytes: number,
  maxLogicalMessageBytes?: number,
): FrameLimits {
  const maxLogicalBytes = maxLogicalMessageBytes ?? MAX_LOGICAL_MESSAGE_BYTES;
  if (
    !Number.isInteger(maxFrameBytes) ||
    maxFrameBytes < MIN_FRAME_BYTES ||
    maxFrameBytes > MAX_LOGICAL_MESSAGE_BYTES ||
    !Number.isInteger(maxLogicalBytes) ||
    maxLogicalBytes < maxFrameBytes ||
    maxLogicalBytes > MAX_LOGICAL_MESSAGE_BYTES
  ) {
    throw new ProtocolFrameError(
      "protocol_invalid",
      "Host frame limits must stay from 1 MiB through 128 MiB",
    );
  }
  return { maxFrameBytes, maxLogicalBytes };
}

function frameFor(
  streamId: string,
  index: number,
  count: number,
  data: string,
): string {
  return JSON.stringify({
    id: `chunk:${streamId}:${index}`,
    method: FRAME_CHUNK_METHOD,
    params: { streamId, index, count, data },
  });
}

function safeSlice(text: string, start: number, take: number): string {
  let end = Math.min(text.length, start + take);
  if (end < text.length) {
    const tail = text.charCodeAt(end - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  }
  if (end <= start) return "";
  return text.slice(start, end);
}

/** One JSON line when the message fits. Larger payloads become frame.chunk. */
export function encodeProtocolMessage(
  message: { id?: string },
  limits: FrameLimits = protocolFrameLimits(),
): string[] {
  const logical = JSON.stringify(message);
  const logicalBytes = Buffer.byteLength(logical, "utf8");
  if (logicalBytes > limits.maxLogicalBytes) {
    throw new ProtocolFrameError(
      "message_too_large",
      `message is ${logicalBytes} bytes; the limit is ${limits.maxLogicalBytes}`,
    );
  }
  if (logicalBytes <= limits.maxFrameBytes) return [logical];
  const streamId = typeof message.id === "string" ? message.id : "unknown";
  let maxData = Math.floor((limits.maxFrameBytes - ENVELOPE_RESERVE) / 6);
  if (maxData < 1) maxData = 1;
  const slices: string[] = [];
  let offset = 0;
  while (offset < logical.length) {
    let take = Math.min(logical.length - offset, maxData);
    let data = "";
    let encoded = "";
    for (;;) {
      data = safeSlice(logical, offset, take);
      if (!data) {
        throw new ProtocolFrameError(
          "frame_too_large",
          "frame limit is too small to encode a chunk",
        );
      }
      encoded = frameFor(streamId, slices.length, COUNT_PROBE, data);
      if (Buffer.byteLength(encoded, "utf8") <= limits.maxFrameBytes) break;
      if (data.length <= 1) {
        throw new ProtocolFrameError(
          "frame_too_large",
          "frame limit is too small to encode a chunk",
        );
      }
      take = Math.max(1, Math.floor(data.length / 2));
    }
    slices.push(data);
    offset += data.length;
  }
  return slices.map((data, index) => {
    const frame = frameFor(streamId, index, slices.length, data);
    if (Buffer.byteLength(frame, "utf8") > limits.maxFrameBytes) {
      throw new ProtocolFrameError(
        "frame_too_large",
        "chunk frame exceeded the limit",
      );
    }
    return frame;
  });
}

type DecodedFrame =
  | { kind: "skip" }
  | { kind: "message"; message: Record<string, unknown> };

export class FrameReassembler {
  private streamId: string | null = null;
  private count = 0;
  private nextIndex = 0;
  private parts: string[] = [];
  private totalBytes = 0;

  constructor(private limits: FrameLimits = protocolFrameLimits()) {}

  setLimits(limits: FrameLimits) {
    if (this.streamId === null) this.limits = limits;
  }

  pushLine(line: string): DecodedFrame {
    const trimmed = line.trim();
    if (!trimmed) return { kind: "skip" };
    if (Buffer.byteLength(trimmed, "utf8") > this.limits.maxFrameBytes) {
      this.reset();
      throw new ProtocolFrameError(
        "frame_too_large",
        "Worker protocol frame exceeded the limit",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.reset();
      throw new ProtocolFrameError("protocol_invalid", "Invalid JSON message");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.reset();
      throw new ProtocolFrameError(
        "protocol_invalid",
        "Protocol message must be an object",
      );
    }
    const message = value as Record<string, unknown>;
    if (message.method !== FRAME_CHUNK_METHOD) {
      if (this.streamId !== null) {
        this.reset();
        throw new ProtocolFrameError(
          "frame_chunk_invalid",
          "Chunk sequence was interrupted",
        );
      }
      return { kind: "message", message };
    }
    return this.pushChunk(message);
  }

  private pushChunk(message: Record<string, unknown>): DecodedFrame {
    const params =
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    const streamId = typeof params.streamId === "string" ? params.streamId : "";
    const index = typeof params.index === "number" ? params.index : Number.NaN;
    const count = typeof params.count === "number" ? params.count : Number.NaN;
    const data = typeof params.data === "string" ? params.data : "";
    if (
      !streamId ||
      !data ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count <= 0 ||
      index < 0 ||
      index >= count
    ) {
      this.reset();
      throw new ProtocolFrameError(
        "frame_chunk_invalid",
        "Chunk is missing streamId, index, count, or data",
      );
    }
    if (index === 0) {
      if (this.streamId !== null) {
        this.reset();
        throw new ProtocolFrameError(
          "frame_chunk_invalid",
          "Chunk sequence was interrupted",
        );
      }
      this.streamId = streamId;
      this.count = count;
      this.nextIndex = 0;
      this.parts = [];
      this.totalBytes = 0;
    }
    if (
      this.streamId !== streamId ||
      index !== this.nextIndex ||
      count !== this.count
    ) {
      this.reset();
      throw new ProtocolFrameError(
        "frame_chunk_invalid",
        "Chunk index or count does not match the sequence",
      );
    }
    this.totalBytes += Buffer.byteLength(data, "utf8");
    if (this.totalBytes > this.limits.maxLogicalBytes) {
      this.reset();
      throw new ProtocolFrameError(
        "message_too_large",
        `message exceeds ${this.limits.maxLogicalBytes} bytes`,
      );
    }
    this.parts.push(data);
    this.nextIndex += 1;
    if (this.nextIndex < this.count) return { kind: "skip" };
    const logical = this.parts.join("");
    const expectedId = streamId;
    this.reset();
    let assembled: unknown;
    try {
      assembled = JSON.parse(logical);
    } catch {
      throw new ProtocolFrameError(
        "protocol_invalid",
        "Reassembled message is not JSON",
      );
    }
    if (
      !assembled ||
      typeof assembled !== "object" ||
      Array.isArray(assembled) ||
      (assembled as { id?: unknown }).id !== expectedId
    ) {
      throw new ProtocolFrameError(
        "frame_chunk_invalid",
        "Reassembled message id does not match the chunk stream",
      );
    }
    return {
      kind: "message",
      message: assembled as Record<string, unknown>,
    };
  }

  private reset() {
    this.streamId = null;
    this.count = 0;
    this.nextIndex = 0;
    this.parts = [];
    this.totalBytes = 0;
  }
}
