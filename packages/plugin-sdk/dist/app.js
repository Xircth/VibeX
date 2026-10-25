import { createPluginContext, isVibeXPluginDefinition, } from './context.js';
export { createPluginContext, definePlugin, defineVibeXPlugin, isVibeXPluginDefinition, setDefaultHostCallTransport, setDefaultWorkerInvokeTransport, } from './context.js';
function isPluginAppSurfaceContext(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value;
    return (record.root != null &&
        typeof record.root === 'object' &&
        record.bridge != null &&
        typeof record.bridge === 'object' &&
        record.signal instanceof AbortSignal);
}
function isPluginContextLike(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value;
    return (typeof record.pluginId === 'string' &&
        typeof record.hostCall === 'function' &&
        record.ui != null &&
        typeof record.ui === 'object' &&
        record.host != null &&
        typeof record.host === 'object');
}
function emptyDomRoot() {
    return {
        replaceChildren() { },
        append() { },
        appendChild(node) {
            return node;
        },
    };
}
function hostDocument() {
    const candidate = globalThis.document;
    if (candidate &&
        typeof candidate === 'object' &&
        typeof candidate.createElement ===
            'function') {
        return candidate;
    }
    return undefined;
}
function surfaceFromPluginContext(ctx) {
    const controller = new AbortController();
    ctx.scope.addDisposer(() => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    });
    const doc = hostDocument();
    const root = doc ? doc.createElement('div') : emptyDomRoot();
    return {
        root,
        document: doc,
        bridge: {
            pluginId: ctx.pluginId,
            generation: ctx.generation,
            invoke: (handler, input) => ctx.worker.invoke(handler, input),
            subscribe() {
                return () => undefined;
            },
            ready() { },
            artifact: {
                get name() {
                    return '';
                },
                readText: () => ctx.hostCall('artifact', 'readText', {}),
                writeText: (content, expectedRevision) => ctx.hostCall('artifact', 'writeText', {
                    content,
                    expectedRevision,
                }),
            },
        },
        signal: controller.signal,
    };
}
function wrapSurfaceSetup(setup) {
    return {
        apiVersion: '2.0',
        mount: setup,
        activate(ctx) {
            const surface = isPluginAppSurfaceContext(ctx)
                ? ctx
                : surfaceFromPluginContext(ctx);
            return setup(surface);
        },
    };
}
function wrapPluginDefinition(definition) {
    return {
        ...definition,
        apiVersion: definition.apiVersion === '1.0' ? '1.0' : '2.0',
        mount(surface) {
            if (isPluginContextLike(surface)) {
                return definition.activate(surface);
            }
            const ctx = createPluginContext({
                pluginId: surface.bridge.pluginId || definition.id || 'plugin.app',
                generation: surface.bridge.generation,
                invokeWorker: (_pluginId, handler, input) => surface.bridge.invoke(handler, input),
            });
            const onAbort = () => ctx.dispose();
            surface.signal.addEventListener('abort', onAbort, { once: true });
            return definition.activate(ctx);
        },
        activate: definition.activate,
    };
}
function wrapPluginContext(context) {
    return {
        apiVersion: '2.0',
        id: context.pluginId,
        mount() {
            return undefined;
        },
        activate() {
            return () => context.dispose();
        },
    };
}
export function definePluginApp(input) {
    if (typeof input === 'function') {
        return wrapSurfaceSetup(input);
    }
    if (isVibeXPluginDefinition(input)) {
        return wrapPluginDefinition(input);
    }
    if (typeof input.activate === 'function') {
        return wrapPluginDefinition(input);
    }
    if (isPluginContextLike(input)) {
        return wrapPluginContext(input);
    }
    throw new TypeError('definePluginApp requires a surface setup, VibeXPluginDefinition, or VibeXPluginContext');
}
