import { createInterface } from 'node:readline';
import { activatePluginWorker, PluginSdkError, } from './worker.js';
export async function runStdioPluginWorker(definition) {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let worker = null;
    let hostSequence = 0;
    const hostPending = new Map();
    const inFlight = new Set();
    const send = (message) => {
        process.stdout.write(`${JSON.stringify(message)}\n`);
    };
    const host = {
        call(capability, operation, value = null) {
            const id = `host:${++hostSequence}`;
            return new Promise((resolve, reject) => {
                hostPending.set(id, { resolve, reject });
                send({
                    id,
                    method: 'host.call',
                    params: { capability, operation, input: value },
                });
            });
        },
    };
    for await (const line of input) {
        if (!line.trim())
            continue;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            send(errorResponse('unknown', 'protocol_invalid', 'Invalid JSON message'));
            continue;
        }
        if ('ok' in message && hostPending.has(message.id)) {
            const pending = hostPending.get(message.id);
            hostPending.delete(message.id);
            if (message.ok)
                pending.resolve(message.result);
            else
                pending.reject(new PluginSdkError(message.error.code, message.error.message));
            continue;
        }
        if (!('method' in message)) {
            send(errorResponse(message.id, 'protocol_invalid', 'Unknown protocol message'));
            continue;
        }
        try {
            switch (message.method) {
                case 'activate': {
                    if (worker) {
                        throw new PluginSdkError('worker_active', 'Plugin worker is already active');
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
                        throw new PluginSdkError('worker_inactive', 'Plugin worker is not active');
                    }
                    const activeWorker = worker;
                    const request = message;
                    // Keep consuming stdin while the handler awaits a Host capability
                    // response. Serially awaiting here deadlocks bidirectional RPC.
                    const invocation = activeWorker
                        .invoke(request.params.handler, request.params.input)
                        .then((result) => send({ id: request.id, ok: true, result }))
                        .catch((error) => {
                        const code = error instanceof PluginSdkError ? error.code : 'worker_failed';
                        const errorMessage = error instanceof Error ? error.message : String(error);
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
        }
        catch (error) {
            const code = error instanceof PluginSdkError ? error.code : 'worker_failed';
            const errorMessage = error instanceof Error ? error.message : String(error);
            send(errorResponse(message.id, code, errorMessage));
        }
    }
    await Promise.allSettled(inFlight);
    await worker?.dispose();
    for (const pending of hostPending.values()) {
        pending.reject(new PluginSdkError('host_closed', 'Host connection closed'));
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
        debug: (message, fields) => write('debug', message, fields),
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
    };
}
