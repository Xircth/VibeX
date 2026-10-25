import {
  isSupportedPluginApiVersion,
  VIBEX_PLUGIN_API_VERSION,
  type JsonValue,
  type PluginApiVersion,
  type PluginContext,
} from './protocol.js';
import type { Disposer } from './registry.js';
import {
  type InjectedServicesRecord,
  type ServiceContainer,
  type ServiceDecorator,
  type ServiceKey,
  type WaterfallInterceptor,
  serviceContainer,
} from './services.js';
import {
  createVolatile,
  type MutableVolatile,
  notifyPluginConfigUpdated,
  type Volatile,
  type VolatileListener,
} from './volatile.js';

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface PluginHostClient {
  call<T extends JsonValue = JsonValue>(
    capability: string,
    operation: string,
    input?: JsonValue
  ): Promise<T>;
}

export interface PluginWorkerServiceRegistry {
  provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer;
  get<T>(key: ServiceKey<T> | string): T | undefined;
  inject<T>(key: ServiceKey<T> | string): T | undefined;
  inject<TResolved = InjectedServicesRecord>(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    effect: (resolved: TResolved) => void | Disposer
  ): Disposer;
  require<T>(key: ServiceKey<T> | string): T;
  has<T>(key: ServiceKey<T> | string): boolean;
  intercept<TPayload = unknown, TResult = TPayload>(
    hookName: string,
    fn:
      | WaterfallInterceptor<TPayload, TResult>
      | ServiceDecorator<TPayload, TResult>,
    order?: number
  ): Disposer;
  runWaterfall<TPayload, TResult>(
    hookName: string,
    initialPayload: TPayload,
    terminal: (payload: TPayload) => Promise<TResult>,
    perHookTimeoutMs?: number
  ): Promise<TResult>;
  subscribe(listener: () => void): Disposer;
}

export function createWorkerServiceRegistry(
  pluginId: string,
  container: ServiceContainer = serviceContainer
): PluginWorkerServiceRegistry {
  function inject<T>(key: ServiceKey<T> | string): T | undefined;
  function inject<TResolved = InjectedServicesRecord>(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    effect: (resolved: TResolved) => void | Disposer
  ): Disposer;
  function inject<T, TResolved = InjectedServicesRecord>(
    keyOrDeps:
      | ServiceKey<T>
      | string
      | ReadonlyArray<ServiceKey<unknown> | string>,
    effect?: (resolved: TResolved) => void | Disposer
  ): T | undefined | Disposer {
    if (Array.isArray(keyOrDeps)) {
      return container.inject(keyOrDeps, effect!, pluginId);
    }
    return container.inject(keyOrDeps as ServiceKey<T> | string);
  }

  return {
    provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer {
      return container.provide(key, implementation, pluginId);
    },
    get<T>(key: ServiceKey<T> | string): T | undefined {
      return container.get(key);
    },
    inject,
    require<T>(key: ServiceKey<T> | string): T {
      return container.require(key);
    },
    has<T>(key: ServiceKey<T> | string): boolean {
      return container.has(key);
    },
    intercept<TPayload = unknown, TResult = TPayload>(
      hookName: string,
      fn:
        | WaterfallInterceptor<TPayload, TResult>
        | ServiceDecorator<TPayload, TResult>,
      order = 0
    ): Disposer {
      return container.intercept(hookName, fn, order, pluginId);
    },
    runWaterfall<TPayload, TResult>(
      hookName: string,
      initialPayload: TPayload,
      terminal: (payload: TPayload) => Promise<TResult>,
      perHookTimeoutMs?: number
    ): Promise<TResult> {
      return container.runWaterfall(
        hookName,
        initialPayload,
        terminal,
        perHookTimeoutMs
      );
    },
    subscribe(listener: () => void): Disposer {
      return container.subscribe(listener);
    },
  };
}

export interface PluginWorkerEnvironment {
  context: PluginContext;
  config: Volatile<Record<string, JsonValue>>;
  host: PluginHostClient;
  services: PluginWorkerServiceRegistry;
  signal: AbortSignal;
  log: {
    debug(message: string, fields?: JsonValue): void;
    info(message: string, fields?: JsonValue): void;
    warn(message: string, fields?: JsonValue): void;
    error(message: string, fields?: JsonValue): void;
  };
}

export function normalizePluginContext(
  context: Partial<PluginContext> &
    Pick<PluginContext, 'pluginId' | 'pluginVersion' | 'generation'>
): PluginContext {
  return {
    pluginId: context.pluginId,
    pluginVersion: context.pluginVersion,
    generation: context.generation,
    packageClass: context.packageClass ?? 'full-trust',
    grantedCapabilities: context.grantedCapabilities ?? ['*'],
    ...(context.config !== undefined ? { config: context.config } : {}),
  };
}

export type PluginHandler = (
  input: JsonValue,
  environment: PluginWorkerEnvironment
) => JsonValue | Promise<JsonValue>;

export interface PluginWorkerRegistrar {
  handle(id: string, handler: PluginHandler): void;
  onConfigUpdate(
    listener: VolatileListener<Record<string, JsonValue>>
  ): Disposer;
  onDispose(disposable: Disposable | (() => void | Promise<void>)): void;
}

export interface PluginWorkerDefinition {
  readonly apiVersion: PluginApiVersion;
  readonly setup: (
    registrar: PluginWorkerRegistrar,
    environment: PluginWorkerEnvironment
  ) => void | Disposable | Promise<void | Disposable>;
}

export interface ActivatedPluginWorker extends Disposable {
  readonly handlers: readonly string[];
  readonly config: Volatile<Record<string, JsonValue>>;
  updateConfig(nextConfig: Record<string, JsonValue>): boolean;
  invoke(handler: string, input: JsonValue): Promise<JsonValue>;
}

export function definePluginWorker(
  setup: PluginWorkerDefinition['setup']
): PluginWorkerDefinition;
export function definePluginWorker(
  definition: PluginWorkerDefinition
): PluginWorkerDefinition;
export function definePluginWorker(
  setupOrDefinition:
    | PluginWorkerDefinition['setup']
    | PluginWorkerDefinition
): PluginWorkerDefinition {
  if (typeof setupOrDefinition === 'function') {
    return { apiVersion: VIBEX_PLUGIN_API_VERSION, setup: setupOrDefinition };
  }
  assertSupportedWorkerApi(setupOrDefinition.apiVersion);
  return {
    apiVersion: setupOrDefinition.apiVersion,
    setup: setupOrDefinition.setup,
  };
}

export async function activatePluginWorker(
  definition: PluginWorkerDefinition,
  environment: Omit<
    PluginWorkerEnvironment,
    'signal' | 'services' | 'config'
  > & {
    services?: PluginWorkerServiceRegistry;
    config?: MutableVolatile<Record<string, JsonValue>>;
  }
): Promise<ActivatedPluginWorker> {
  assertSupportedWorkerApi(definition.apiVersion);
  const controller = new AbortController();
  const handlers = new Map<string, PluginHandler>();
  const disposables: Array<Disposable | (() => void | Promise<void>)> = [];
  let disposed = false;
  const scopedServices =
    environment.services ??
    createWorkerServiceRegistry(environment.context.pluginId);
  const initialConfig =
    environment.context.config &&
    typeof environment.context.config === 'object' &&
    !Array.isArray(environment.context.config)
      ? { ...environment.context.config }
      : {};
  const volatileConfig =
    environment.config ??
    createVolatile<Record<string, JsonValue>>(initialConfig);
  notifyPluginConfigUpdated(
    environment.context.pluginId,
    volatileConfig.get()
  );
  const workerContext: PluginContext = {
    ...environment.context,
    config: volatileConfig.get(),
  };
  const workerEnvironment: PluginWorkerEnvironment = {
    ...environment,
    context: workerContext,
    config: volatileConfig,
    services: scopedServices,
    signal: controller.signal,
  };
  const registrar: PluginWorkerRegistrar = {
    handle(id, handler) {
      validateHandlerId(id);
      if (handlers.has(id)) {
        throw new PluginSdkError(
          'handler_duplicate',
          `Handler ${id} is already registered`
        );
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
  if (setupDisposable) disposables.push(setupDisposable);

  return {
    get handlers() {
      return [...handlers.keys()].sort();
    },
    get config() {
      return volatileConfig;
    },
    updateConfig(nextConfig) {
      if (disposed) return false;
      const normalized =
        nextConfig && typeof nextConfig === 'object' && !Array.isArray(nextConfig)
          ? { ...nextConfig }
          : {};
      workerContext.config = normalized;
      notifyPluginConfigUpdated(environment.context.pluginId, normalized);
      return volatileConfig.set(normalized);
    },
    async invoke(handler, input) {
      if (disposed) {
        throw new PluginSdkError(
          'worker_disposed',
          'Plugin worker is disposed'
        );
      }
      const registered = handlers.get(handler);
      if (!registered) {
        throw new PluginSdkError(
          'handler_not_found',
          `Handler ${handler} is not registered`
        );
      }
      return registered(input, workerEnvironment);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      const errors: unknown[] = [];
      for (const disposable of [...disposables].reverse()) {
        try {
          if (typeof disposable === 'function') await disposable();
          else await disposable.dispose();
        } catch (error) {
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

export async function createWorkerHost(
  definition: PluginWorkerDefinition,
  environment: Omit<
    PluginWorkerEnvironment,
    'signal' | 'services' | 'config'
  > & {
    services?: PluginWorkerServiceRegistry;
    config?: MutableVolatile<Record<string, JsonValue>>;
  }
): Promise<ActivatedPluginWorker> {
  return activatePluginWorker(definition, environment);
}

function assertSupportedWorkerApi(
  apiVersion: unknown
): asserts apiVersion is PluginApiVersion {
  if (!isSupportedPluginApiVersion(apiVersion)) {
    throw new PluginSdkError(
      'sdk_incompatible',
      `Unsupported worker API ${String(apiVersion)}`
    );
  }
}

export class PluginSdkError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginSdkError';
  }
}

function validateHandlerId(id: string) {
  if (!/^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$/.test(id)) {
    throw new PluginSdkError(
      'handler_id_invalid',
      `Handler ${id} must be a namespaced lower-camel identifier`
    );
  }
}
