export declare const VIBEX_PLUGIN_API_VERSION: "1.0";
export declare const VIBEX_PLUGIN_PROTOCOL_VERSION: "1.1";
export declare const MIN_FRAME_BYTES: number;
export declare const MAX_FRAME_BYTES: number;
export declare const MAX_LOGICAL_MESSAGE_BYTES: number;
export declare const FRAME_CHUNK_METHOD = "frame.chunk";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type PackageClass = "full-trust" | "isolated";
export interface InitializeParams {
    protocolRange: ["1.1"];
    hostVersion: string;
    pluginIdentity: {
        publisher: string;
        id: string;
    };
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
    runtime: {
        id: string;
        version: string;
        target: string;
        digest: string;
    };
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
export type WorkerRequest = {
    id: string;
    method: "initialize";
    params: InitializeParams;
} | {
    id: string;
    method: "activate";
    params: PluginContext;
} | {
    id: string;
    method: "invoke";
    params: {
        handler: string;
        input: JsonValue;
    };
} | {
    id: string;
    method: "dispose";
    params: {
        reason: string;
    };
} | {
    id: string;
    method: "ping";
    params: Record<string, never>;
};
export type WorkerResponse = {
    id: string;
    ok: true;
    result: JsonValue;
} | {
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
        details?: JsonValue;
    };
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
export declare class ProtocolFrameError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface FrameLimits {
    maxFrameBytes: number;
    maxLogicalBytes: number;
}
export declare function protocolFrameLimits(): FrameLimits;
/** Limits the Host advertised in initialize. Frame stays inside 1 MiB..=128 MiB. */
export declare function frameLimitsFromAdvertised(maxFrameBytes: number, maxLogicalMessageBytes?: number): FrameLimits;
/** One JSON line when the message fits. Larger payloads become frame.chunk. */
export declare function encodeProtocolMessage(message: {
    id?: string;
}, limits?: FrameLimits): string[];
type DecodedFrame = {
    kind: "skip";
} | {
    kind: "message";
    message: Record<string, unknown>;
};
export declare class FrameReassembler {
    private limits;
    private streamId;
    private count;
    private nextIndex;
    private parts;
    private totalBytes;
    constructor(limits?: FrameLimits);
    setLimits(limits: FrameLimits): void;
    pushLine(line: string): DecodedFrame;
    private pushChunk;
    private reset;
}
export {};
