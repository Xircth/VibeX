import type { JsonValue } from './protocol.js';
import {
  createPluginContext,
  isVibeXPluginDefinition,
  type VibeXPluginContext,
  type VibeXPluginDefinition,
} from './context.js';

export {
  createPluginContext,
  type CreatePluginContextOptions,
  definePlugin,
  defineVibeXPlugin,
  type HostCallTransport,
  isVibeXPluginDefinition,
  type PluginKvClient,
  type PluginNetworkFetchInput,
  type PluginNetworkFetchResponse,
  type PluginSettingsClient,
  setDefaultHostCallTransport,
  setDefaultWorkerInvokeTransport,
  type VibeXPluginContext,
  type VibeXPluginDefinition,
  type WorkerInvokeTransport,
} from './context.js';

export interface PluginAppDomRoot {
  replaceChildren(...nodes: unknown[]): void;
  append(...nodes: unknown[]): void;
  appendChild<T>(node: T): T;
}

export interface PluginAppArtifactBridge {
  readonly name: string;
  readText(): Promise<{
    name: string;
    content: string;
    revision: string;
  }>;
  writeText(
    content: string,
    expectedRevision: string
  ): Promise<{ revision: string }>;
}

export interface PluginAppBridge {
  readonly pluginId: string;
  readonly generation: number;
  invoke<T = JsonValue>(handler: string, input?: JsonValue): Promise<T>;
  subscribe(
    channel: string,
    listener: (payload: JsonValue) => void
  ): () => void;
  ready(): void;
  readonly artifact?: PluginAppArtifactBridge;
}

export interface PluginAppSurfaceContext {
  readonly root: PluginAppDomRoot;
  readonly document?: unknown;
  readonly bridge: PluginAppBridge;
  readonly signal: AbortSignal;
}

export type PluginAppSurfaceSetup = (
  context: PluginAppSurfaceContext
) => void | (() => void) | Promise<void | (() => void)>;

export interface PluginAppDefinition extends VibeXPluginDefinition {
  readonly mount: PluginAppSurfaceSetup;
}

function isPluginAppSurfaceContext(
  value: unknown
): value is PluginAppSurfaceContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<PluginAppSurfaceContext>;
  return (
    record.root != null &&
    typeof record.root === 'object' &&
    record.bridge != null &&
    typeof record.bridge === 'object' &&
    record.signal instanceof AbortSignal
  );
}

function isPluginContextLike(value: unknown): value is VibeXPluginContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<VibeXPluginContext>;
  return (
    typeof record.pluginId === 'string' &&
    typeof record.hostCall === 'function' &&
    record.ui != null &&
    typeof record.ui === 'object' &&
    record.host != null &&
    typeof record.host === 'object'
  );
}

function emptyDomRoot(): PluginAppDomRoot {
  return {
    replaceChildren() {},
    append() {},
    appendChild<T>(node: T) {
      return node;
    },
  };
}

function hostDocument():
  | { createElement(tag: string): PluginAppDomRoot }
  | undefined {
  const candidate = (globalThis as { document?: unknown }).document;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as { createElement?: unknown }).createElement ===
      'function'
  ) {
    return candidate as { createElement(tag: string): PluginAppDomRoot };
  }
  return undefined;
}

function surfaceFromPluginContext(
  ctx: VibeXPluginContext
): PluginAppSurfaceContext {
  const controller = new AbortController();
  ctx.scope.addDisposer(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  });
  const doc = hostDocument();
  const root: PluginAppDomRoot = doc ? doc.createElement('div') : emptyDomRoot();
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
      ready() {},
      artifact: {
        get name() {
          return '';
        },
        readText: () => ctx.hostCall('artifact', 'readText', {}),
        writeText: (content, expectedRevision) =>
          ctx.hostCall('artifact', 'writeText', {
            content,
            expectedRevision,
          }),
      },
    },
    signal: controller.signal,
  };
}

function wrapSurfaceSetup(setup: PluginAppSurfaceSetup): PluginAppDefinition {
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

function wrapPluginDefinition(
  definition: VibeXPluginDefinition
): PluginAppDefinition {
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
        invokeWorker: (_pluginId, handler, input) =>
          surface.bridge.invoke(handler, input),
      });
      const onAbort = () => ctx.dispose();
      surface.signal.addEventListener('abort', onAbort, { once: true });
      return definition.activate(ctx);
    },
    activate: definition.activate,
  };
}

function wrapPluginContext(context: VibeXPluginContext): PluginAppDefinition {
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

export function definePluginApp(
  setup: PluginAppSurfaceSetup
): PluginAppDefinition;
export function definePluginApp(
  definition: VibeXPluginDefinition
): PluginAppDefinition;
export function definePluginApp(
  context: VibeXPluginContext
): PluginAppDefinition;
export function definePluginApp(
  input: PluginAppSurfaceSetup | VibeXPluginDefinition | VibeXPluginContext
): PluginAppDefinition {
  if (typeof input === 'function') {
    return wrapSurfaceSetup(input);
  }
  if (isVibeXPluginDefinition(input)) {
    return wrapPluginDefinition(input);
  }
  if (typeof (input as { activate?: unknown }).activate === 'function') {
    return wrapPluginDefinition(input as unknown as VibeXPluginDefinition);
  }
  if (isPluginContextLike(input)) {
    return wrapPluginContext(input);
  }
  throw new TypeError(
    'definePluginApp requires a surface setup, VibeXPluginDefinition, or VibeXPluginContext'
  );
}
