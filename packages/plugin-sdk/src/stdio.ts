import { createInterface } from "node:readline";

import type {
  HostRequest,
  HostResponse,
  JsonValue,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
import {
  FrameReassembler,
  ProtocolFrameError,
  VIBEX_PLUGIN_API_VERSION,
  VIBEX_PLUGIN_PROTOCOL_VERSION,
  encodeProtocolMessage,
  frameLimitsFromAdvertised,
  protocolFrameLimits,
} from "./protocol.js";
import {
  activatePluginWorker,
  PluginSdkError,
  type ActivatedPluginWorker,
  type PluginHostClient,
  type PluginWorkerDefinition,
} from "./worker.js";

export async function runStdioPluginWorker(
  definition: PluginWorkerDefinition,
): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let worker: ActivatedPluginWorker | null = null;
  let hostSequence = 0;
  const hostPending = new Map<
    string,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();
  const inFlight = new Set<Promise<void>>();
  const limits = protocolFrameLimits();
  const frames = new FrameReassembler(limits);
  const send = (message: WorkerResponse | HostRequest) => {
    let encoded: string[];
    try {
      encoded = encodeProtocolMessage(message, limits);
    } catch (error) {
      const code =
        error instanceof ProtocolFrameError ? error.code : "worker_failed";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      encoded = [JSON.stringify(errorResponse(message.id, code, errorMessage))];
    }
    for (const frame of encoded) process.stdout.write(`${frame}\n`);
  };
  const host: PluginHostClient = {
    call<T extends JsonValue = JsonValue>(
      capability: string,
      operation: string,
      value: JsonValue = null,
    ): Promise<T> {
      const id = `host:${++hostSequence}`;
      return new Promise<JsonValue>((resolve, reject) => {
        hostPending.set(id, { resolve, reject });
        send({
          id,
          method: "host.call",
          params: { capability, operation, input: value },
        });
      }) as Promise<T>;
    },
  };

  for await (const line of input) {
    let message: WorkerRequest | HostResponse;
    try {
      const decoded = frames.pushLine(line);
      if (decoded.kind === "skip") continue;
      message = decoded.message as WorkerRequest | HostResponse;
    } catch (error) {
      const code =
        error instanceof ProtocolFrameError
          ? workerFrameErrorCode(error.code)
          : "protocol_invalid";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      send(errorResponse("unknown", code, errorMessage));
      continue;
    }
    if ("ok" in message && hostPending.has(message.id)) {
      const pending = hostPending.get(message.id)!;
      hostPending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(
          new PluginSdkError(message.error.code, message.error.message),
        );
      continue;
    }
    if (!("method" in message)) {
      send(
        errorResponse(
          message.id,
          "protocol_invalid",
          "Unknown protocol message",
        ),
      );
      continue;
    }
    try {
      switch (message.method) {
        case "initialize": {
          if (!message.params.protocolRange.includes("1.1")) {
            throw new PluginSdkError(
              "protocol_unsupported",
              "Host protocol range does not include 1.1",
            );
          }
          const advertised = message.params.limits;
          if (
            advertised?.maxFrameBytes != null ||
            advertised?.maxLogicalMessageBytes != null
          ) {
            const next = frameLimitsFromAdvertised(
              advertised.maxFrameBytes ?? limits.maxFrameBytes,
              advertised.maxLogicalMessageBytes,
            );
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
            throw new PluginSdkError(
              "worker_active",
              "Plugin worker is already active",
            );
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
            throw new PluginSdkError(
              "worker_inactive",
              "Plugin worker is not active",
            );
          }
          const activeWorker = worker;
          const request = message;
          // Keep consuming stdin while the handler awaits a Host capability
          // response. Serially awaiting here deadlocks bidirectional RPC.
          const invocation = activeWorker
            .invoke(request.params.handler, request.params.input)
            .then((result) => send({ id: request.id, ok: true, result }))
            .catch((error: unknown) => {
              const code =
                error instanceof PluginSdkError ? error.code : "worker_failed";
              const errorMessage =
                error instanceof Error ? error.message : String(error);
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
          const method = String((message as { method?: string }).method ?? "");
          throw new PluginSdkError(
            "protocol_invalid",
            `Unknown method ${method}`,
          );
        }
      }
    } catch (error) {
      const code =
        error instanceof PluginSdkError || error instanceof ProtocolFrameError
          ? error.code
          : "worker_failed";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      send(errorResponse(message.id, code, errorMessage));
    }
  }
  await Promise.allSettled(inFlight);
  await worker?.dispose();
  for (const pending of hostPending.values()) {
    pending.reject(new PluginSdkError("host_closed", "Host connection closed"));
  }
}

function workerFrameErrorCode(code: string): string {
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

function errorResponse(
  id: string,
  code: string,
  message: string,
): WorkerResponse {
  return { id, ok: false, error: { code, message } };
}

function createStderrLogger() {
  const write = (level: string, message: string, fields?: JsonValue) => {
    process.stderr.write(
      `${JSON.stringify({ level, message, fields: fields ?? null })}\n`,
    );
  };
  return {
    debug: (message: string, fields?: JsonValue) =>
      write("debug", message, fields),
    info: (message: string, fields?: JsonValue) =>
      write("info", message, fields),
    warn: (message: string, fields?: JsonValue) =>
      write("warn", message, fields),
    error: (message: string, fields?: JsonValue) =>
      write("error", message, fields),
  };
}
