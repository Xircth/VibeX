import { createInterface } from 'node:readline';

import type {
  HostRequest,
  HostResponse,
  JsonValue,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';
import {
  activatePluginWorker,
  PluginSdkError,
  type ActivatedPluginWorker,
  type PluginHostClient,
  type PluginWorkerDefinition,
} from './worker.js';

export async function runStdioPluginWorker(
  definition: PluginWorkerDefinition
): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let worker: ActivatedPluginWorker | null = null;
  let hostSequence = 0;
  const hostPending = new Map<
    string,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();
  const inFlight = new Set<Promise<void>>();
  const send = (message: WorkerResponse | HostRequest) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const host: PluginHostClient = {
    call<T extends JsonValue = JsonValue>(
      capability: string,
      operation: string,
      value: JsonValue = null
    ): Promise<T> {
      const id = `host:${++hostSequence}`;
      return new Promise<JsonValue>((resolve, reject) => {
        hostPending.set(id, { resolve, reject });
        send({
          id,
          method: 'host.call',
          params: { capability, operation, input: value },
        });
      }) as Promise<T>;
    },
  };

  for await (const line of input) {
    if (!line.trim()) continue;
    let message: WorkerRequest | HostResponse;
    try {
      message = JSON.parse(line) as WorkerRequest | HostResponse;
    } catch {
      send(
        errorResponse('unknown', 'protocol_invalid', 'Invalid JSON message')
      );
      continue;
    }
    if ('ok' in message && hostPending.has(message.id)) {
      const pending = hostPending.get(message.id)!;
      hostPending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(
          new PluginSdkError(message.error.code, message.error.message)
        );
      continue;
    }
    if (!('method' in message)) {
      send(
        errorResponse(
          message.id,
          'protocol_invalid',
          'Unknown protocol message'
        )
      );
      continue;
    }
    try {
      switch (message.method) {
        case 'activate': {
          if (worker) {
            throw new PluginSdkError(
              'worker_active',
              'Plugin worker is already active'
            );
          }
          worker = await activatePluginWorker(definition, {
            context: message.params,
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
        case 'invoke': {
          if (!worker) {
            throw new PluginSdkError(
              'worker_inactive',
              'Plugin worker is not active'
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
                error instanceof PluginSdkError ? error.code : 'worker_failed';
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              send(errorResponse(request.id, code, errorMessage));
            });
          inFlight.add(invocation);
          void invocation.finally(() => inFlight.delete(invocation));
          break;
        }
        case 'dispose': {
          await worker?.dispose();
          worker = null;
          send({ id: message.id, ok: true, result: null });
          break;
        }
        case 'ping':
          send({ id: message.id, ok: true, result: { apiVersion: '1.0' } });
          break;
      }
    } catch (error) {
      const code =
        error instanceof PluginSdkError ? error.code : 'worker_failed';
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      send(errorResponse(message.id, code, errorMessage));
    }
  }
  await Promise.allSettled(inFlight);
  await worker?.dispose();
  for (const pending of hostPending.values()) {
    pending.reject(new PluginSdkError('host_closed', 'Host connection closed'));
  }
}

function errorResponse(
  id: string,
  code: string,
  message: string
): WorkerResponse {
  return { id, ok: false, error: { code, message } };
}

function createStderrLogger() {
  const write = (level: string, message: string, fields?: JsonValue) => {
    process.stderr.write(
      `${JSON.stringify({ level, message, fields: fields ?? null })}\n`
    );
  };
  return {
    debug: (message: string, fields?: JsonValue) =>
      write('debug', message, fields),
    info: (message: string, fields?: JsonValue) =>
      write('info', message, fields),
    warn: (message: string, fields?: JsonValue) =>
      write('warn', message, fields),
    error: (message: string, fields?: JsonValue) =>
      write('error', message, fields),
  };
}
