export function definePluginWorker(setup) {
    return { apiVersion: '1.0', setup };
}
export async function activatePluginWorker(definition, environment) {
    if (definition.apiVersion !== '1.0') {
        throw new PluginSdkError('sdk_incompatible', `Unsupported worker API ${String(definition.apiVersion)}`);
    }
    const controller = new AbortController();
    const handlers = new Map();
    const disposables = [];
    let disposed = false;
    const workerEnvironment = {
        ...environment,
        signal: controller.signal,
    };
    const registrar = {
        handle(id, handler) {
            validateHandlerId(id);
            if (handlers.has(id)) {
                throw new PluginSdkError('handler_duplicate', `Handler ${id} is already registered`);
            }
            handlers.set(id, handler);
        },
        onDispose(disposable) {
            disposables.push(disposable);
        },
    };
    const setupDisposable = await definition.setup(registrar, workerEnvironment);
    if (setupDisposable)
        disposables.push(setupDisposable);
    return {
        get handlers() {
            return [...handlers.keys()].sort();
        },
        async invoke(handler, input) {
            if (disposed) {
                throw new PluginSdkError('worker_disposed', 'Plugin worker is disposed');
            }
            const registered = handlers.get(handler);
            if (!registered) {
                throw new PluginSdkError('handler_not_found', `Handler ${handler} is not registered`);
            }
            return registered(input, workerEnvironment);
        },
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            controller.abort();
            const errors = [];
            for (const disposable of [...disposables].reverse()) {
                try {
                    if (typeof disposable === 'function')
                        await disposable();
                    else
                        await disposable.dispose();
                }
                catch (error) {
                    errors.push(error);
                }
            }
            handlers.clear();
            if (errors.length) {
                throw new AggregateError(errors, 'Plugin worker disposal failed');
            }
        },
    };
}
export class PluginSdkError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PluginSdkError';
    }
}
function validateHandlerId(id) {
    if (!/^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$/.test(id)) {
        throw new PluginSdkError('handler_id_invalid', `Handler ${id} must be a namespaced lower-camel identifier`);
    }
}
