import type { JsonValue, PluginContext } from './protocol.js';

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

export interface PluginWorkerEnvironment {
  context: PluginContext;
  host: PluginHostClient;
  signal: AbortSignal;
  log: {
    debug(message: string, fields?: JsonValue): void;
    info(message: string, fields?: JsonValue): void;
    warn(message: string, fields?: JsonValue): void;
    error(message: string, fields?: JsonValue): void;
  };
}

export type PluginHandler = (
  input: JsonValue,
  environment: PluginWorkerEnvironment
) => JsonValue | Promise<JsonValue>;

export interface PluginWorkerRegistrar {
  handle(id: string, handler: PluginHandler): void;
  onDispose(disposable: Disposable | (() => void | Promise<void>)): void;
}

export interface PluginWorkerDefinition {
  readonly apiVersion: '1.0';
  readonly setup: (
    registrar: PluginWorkerRegistrar,
    environment: PluginWorkerEnvironment
  ) => void | Disposable | Promise<void | Disposable>;
}

export interface ActivatedPluginWorker extends Disposable {
  readonly handlers: readonly string[];
  invoke(handler: string, input: JsonValue): Promise<JsonValue>;
}

export function definePluginWorker(
  setup: PluginWorkerDefinition['setup']
): PluginWorkerDefinition {
  return { apiVersion: '1.0', setup };
}

export async function activatePluginWorker(
  definition: PluginWorkerDefinition,
  environment: Omit<PluginWorkerEnvironment, 'signal'>
): Promise<ActivatedPluginWorker> {
  if (definition.apiVersion !== '1.0') {
    throw new PluginSdkError(
      'sdk_incompatible',
      `Unsupported worker API ${String(definition.apiVersion)}`
    );
  }
  const controller = new AbortController();
  const handlers = new Map<string, PluginHandler>();
  const disposables: Array<Disposable | (() => void | Promise<void>)> = [];
  let disposed = false;
  const workerEnvironment: PluginWorkerEnvironment = {
    ...environment,
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
      handlers.clear();
      if (errors.length) {
        throw new AggregateError(errors, 'Plugin worker disposal failed');
      }
    },
  };
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
