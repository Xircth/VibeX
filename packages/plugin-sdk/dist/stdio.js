import { FrameReassembler, ProtocolFrameError, VIBEX_PLUGIN_API_VERSION, VIBEX_PLUGIN_PROTOCOL_VERSION, encodeProtocolMessage, frameLimitsFromAdvertised, protocolFrameLimits, } from "./protocol.js";
import { activatePluginWorker, PluginSdkError, } from "./worker.js";
export async function runStdioPluginWorker(definition) {
    const readlineModuleId = `node:${"readline"}`;
    const { createInterface } = (await import(
    /* @vite-ignore */ readlineModuleId));
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let worker = null;
    let hostSequence = 0;
    const hostPending = new Map();
    const inFlight = new Set();
    const limits = protocolFrameLimits();
    const frames = new FrameReassembler(limits);
    const send = (message) => {
        let encoded;
        try {
            encoded = encodeProtocolMessage(message, limits);
        }
        catch (error) {
            const code = error instanceof ProtocolFrameError ? error.code : "worker_failed";
            const errorMessage = error instanceof Error ? error.message : String(error);
            encoded = [JSON.stringify(errorResponse(message.id, code, errorMessage))];
        }
        for (const frame of encoded)
            process.stdout.write(`${frame}\n`);
    };
    const host = {
        call(capability, operation, value = null) {
            const id = `host:${++hostSequence}`;
            return new Promise((resolve, reject) => {
                hostPending.set(id, { resolve, reject });
                send({
                    id,
                    method: "host.call",
                    params: { capability, operation, input: value },
                });
            });
        },
    };
    for await (const line of input) {
        let message;
        try {
            const decoded = frames.pushLine(line);
            if (decoded.kind === "skip")
                continue;
            message = decoded.message;
        }
        catch (error) {
            const code = error instanceof ProtocolFrameError
                ? workerFrameErrorCode(error.code)
                : "protocol_invalid";
            const errorMessage = error instanceof Error ? error.message : String(error);
            send(errorResponse("unknown", code, errorMessage));
            continue;
        }
        if ("ok" in message && hostPending.has(message.id)) {
            const pending = hostPending.get(message.id);
            hostPending.delete(message.id);
            if (message.ok)
                pending.resolve(message.result);
            else
                pending.reject(new PluginSdkError(message.error.code, message.error.message));
            continue;
        }
        if (!("method" in message)) {
            send(errorResponse(message.id, "protocol_invalid", "Unknown protocol message"));
            continue;
        }
        try {
            switch (message.method) {
                case "initialize": {
                    if (!message.params.protocolRange.includes("1.1")) {
                        throw new PluginSdkError("protocol_unsupported", "Host protocol range does not include 1.1");
                    }
                    const advertised = message.params.limits;
                    if (advertised?.maxFrameBytes != null ||
                        advertised?.maxLogicalMessageBytes != null) {
                        const next = frameLimitsFromAdvertised(advertised.maxFrameBytes ?? limits.maxFrameBytes, advertised.maxLogicalMessageBytes);
                        limits.maxFrameBytes = next.maxFrameBytes;
                        limits.maxLogicalBytes = next.maxLogicalBytes;
                        frames.setLimits(limits);
                    }
                    send({
                        id: message.id,
                        ok: true,
                        result: {
                            protocolVersion: VIBEX_PLUGIN_PROTOCOL_VERSION,
                            sdkVersion: VIBEX_PLUGIN_API_VERSION,
                            registrations: [],
                            requestedFeatures: [],
                        },
                    });
                    break;
                }
                case "activate": {
                    if (worker) {
                        throw new PluginSdkError("worker_active", "Plugin worker is already active");
                    }
                    worker = await activatePluginWorker(definition, {
                        context: {
                            pluginId: message.params.pluginId,
                            pluginVersion: message.params.pluginVersion,
                            generation: message.params.generation,
                            packageClass: message.params.packageClass ?? "full-trust",
                            grantedCapabilities: message.params.grantedCapabilities ?? ["*"],
                        },
                        host,
                        log: createStderrLogger(),
                    });
                    send({
                        id: message.id,
                        ok: true,
                        result: { handlers: [...worker.handlers] },
                    });
                    break;
                }
                case "invoke": {
                    if (!worker) {
                        throw new PluginSdkError("worker_inactive", "Plugin worker is not active");
                    }
                    const activeWorker = worker;
                    const request = message;
                    // Keep consuming stdin while the handler awaits a Host capability
                    // response. Serially awaiting here deadlocks bidirectional RPC.
                    const invocation = activeWorker
                        .invoke(request.params.handler, request.params.input)
                        .then((result) => send({ id: request.id, ok: true, result }))
                        .catch((error) => {
                        const code = error instanceof PluginSdkError ? error.code : "worker_failed";
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        send(errorResponse(request.id, code, errorMessage));
                    });
                    inFlight.add(invocation);
                    void invocation.finally(() => inFlight.delete(invocation));
                    break;
                }
                case "dispose": {
                    await worker?.dispose();
                    worker = null;
                    send({ id: message.id, ok: true, result: null });
                    break;
                }
                case "ping":
                    send({ id: message.id, ok: true, result: { apiVersion: "1.0" } });
                    break;
                default: {
                    const method = String(message.method ?? "");
                    throw new PluginSdkError("protocol_invalid", `Unknown method ${method}`);
                }
            }
        }
        catch (error) {
            const code = error instanceof PluginSdkError || error instanceof ProtocolFrameError
                ? error.code
                : "worker_failed";
            const errorMessage = error instanceof Error ? error.message : String(error);
            send(errorResponse(message.id, code, errorMessage));
        }
    }
    await Promise.allSettled(inFlight);
    await worker?.dispose();
    for (const pending of hostPending.values()) {
        pending.reject(new PluginSdkError("host_closed", "Host connection closed"));
    }
}
function workerFrameErrorCode(code) {
    switch (code) {
        case "frame_too_large":
            return "worker_frame_too_large";
        case "frame_chunk_invalid":
            return "worker_frame_chunk_invalid";
        case "message_too_large":
            return "worker_message_too_large";
        default:
            return "protocol_invalid";
    }
}
function errorResponse(id, code, message) {
    return { id, ok: false, error: { code, message } };
}
function createStderrLogger() {
    const write = (level, message, fields) => {
        process.stderr.write(`${JSON.stringify({ level, message, fields: fields ?? null })}\n`);
    };
    return {
        debug: (message, fields) => write("debug", message, fields),
        info: (message, fields) => write("info", message, fields),
        warn: (message, fields) => write("warn", message, fields),
        error: (message, fields) => write("error", message, fields),
    };
}
const SHARED_HOST_GLOBAL_KEY = "__VIBEX_SHARED_PLUGIN_HOST__";
/**
 * Returns the shared Node plugin host runtime if the current worker is
 * executing inside VibeX's multiplexed `SharedNodeWorkerHost` process, or
 * `null` when running in a standalone single-plugin process.
 */
export function getSharedNodePluginHost() {
    const candidate = globalThis[SHARED_HOST_GLOBAL_KEY];
    if (candidate &&
        typeof candidate === "object" &&
        candidate.slots instanceof Map &&
        candidate.services instanceof Map) {
        return candidate;
    }
    return null;
}
/**
 * Returns `true` when this worker is executing inside the multiplexed
 * `SharedNodeWorkerHost` Node.js process.
 */
export function isSharedNodePluginHost() {
    return getSharedNodePluginHost() !== null;
}
