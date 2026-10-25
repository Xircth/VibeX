import { isSupportedPluginApiVersion, VIBEX_PLUGIN_API_VERSION, } from './protocol.js';
import { serviceContainer, } from './services.js';
import { createVolatile, notifyPluginConfigUpdated, } from './volatile.js';
export function createWorkerServiceRegistry(pluginId, container = serviceContainer) {
    function inject(keyOrDeps, effect) {
        if (Array.isArray(keyOrDeps)) {
            return container.inject(keyOrDeps, effect, pluginId);
        }
        return container.inject(keyOrDeps);
    }
    return {
        provide(key, implementation) {
            return container.provide(key, implementation, pluginId);
        },
        get(key) {
            return container.get(key);
        },
        inject,
        require(key) {
            return container.require(key);
        },
        has(key) {
            return container.has(key);
        },
        intercept(hookName, fn, order = 0) {
            return container.intercept(hookName, fn, order, pluginId);
        },
        runWaterfall(hookName, initialPayload, terminal, perHookTimeoutMs) {
            return container.runWaterfall(hookName, initialPayload, terminal, perHookTimeoutMs);
        },
        subscribe(listener) {
            return container.subscribe(listener);
        },
    };
}
export function normalizePluginContext(context) {
    return {
        pluginId: context.pluginId,
        pluginVersion: context.pluginVersion,
        generation: context.generation,
        packageClass: context.packageClass ?? 'full-trust',
        grantedCapabilities: context.grantedCapabilities ?? ['*'],
        ...(context.config !== undefined ? { config: context.config } : {}),
    };
}
export function definePluginWorker(setupOrDefinition) {
    if (typeof setupOrDefinition === 'function') {
        return { apiVersion: VIBEX_PLUGIN_API_VERSION, setup: setupOrDefinition };
    }
    assertSupportedWorkerApi(setupOrDefinition.apiVersion);
    return {
        apiVersion: setupOrDefinition.apiVersion,
        setup: setupOrDefinition.setup,
    };
}
export async function activatePluginWorker(definition, environment) {
    assertSupportedWorkerApi(definition.apiVersion);
    const controller = new AbortController();
    const handlers = new Map();
    const disposables = [];
    let disposed = false;
    const scopedServices = environment.services ??
        createWorkerServiceRegistry(environment.context.pluginId);
    const initialConfig = environment.context.config &&
        typeof environment.context.config === 'object' &&
        !Array.isArray(environment.context.config)
        ? { ...environment.context.config }
        : {};
    const volatileConfig = environment.config ??
        createVolatile(initialConfig);
    notifyPluginConfigUpdated(environment.context.pluginId, volatileConfig.get());
    const workerContext = {
        ...environment.context,
        config: volatileConfig.get(),
    };
    const workerEnvironment = {
        ...environment,
        context: workerContext,
        config: volatileConfig,
        services: scopedServices,
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
        onConfigUpdate(listener) {
            const disposeSub = volatileConfig.subscribe(listener);
            disposables.push(disposeSub);
            return disposeSub;
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
        get config() {
            return volatileConfig;
        },
        updateConfig(nextConfig) {
            if (disposed)
                return false;
            const normalized = nextConfig && typeof nextConfig === 'object' && !Array.isArray(nextConfig)
                ? { ...nextConfig }
                : {};
            workerContext.config = normalized;
            notifyPluginConfigUpdated(environment.context.pluginId, normalized);
            return volatileConfig.set(normalized);
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
            serviceContainer.disposeByPlugin(environment.context.pluginId);
            handlers.clear();
            if (errors.length) {
                throw new AggregateError(errors, 'Plugin worker disposal failed');
            }
        },
    };
}
export async function createWorkerHost(definition, environment) {
    return activatePluginWorker(definition, environment);
}
function assertSupportedWorkerApi(apiVersion) {
    if (!isSupportedPluginApiVersion(apiVersion)) {
        throw new PluginSdkError('sdk_incompatible', `Unsupported worker API ${String(apiVersion)}`);
    }
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
