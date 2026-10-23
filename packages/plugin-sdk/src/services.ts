import type { Disposer } from './registry.js';

export interface ServiceKey<T> {
  readonly id: string;
  readonly __type?: T;
}

export function createServiceKey<T>(id: string): ServiceKey<T> {
  return Object.freeze({ id });
}

function normalizeServiceId<T>(key: ServiceKey<T> | string): string {
  return typeof key === 'string' ? key : key.id;
}

interface ProvidedServiceRecord {
  readonly id: string;
  readonly ownerPluginId?: string;
  readonly value: unknown;
}

export type InjectedServicesRecord = Record<string, unknown> & Iterable<unknown>;

export type ServiceDecorator<TService = unknown, TResult = TService> = (
  previousService: TService
) => TResult;

export type WaterfallInterceptor<TPayload, TResult> = (
  payload: TPayload,
  next: (modifiedPayload: TPayload) => Promise<TResult>
) => Promise<TResult>;

interface InterceptorEntry {
  readonly ownerPluginId?: string;
  readonly order: number;
  readonly fn: WaterfallInterceptor<unknown, unknown>;
}

/**
 * Cordis-inspired cross-plugin service container with owner-scoped auto-revocation,
 * multi-dependency reactive `inject(deps, effect)`, and onion-model waterfall interceptors
 * with per-hook timeout degradation.
 */
export class ServiceContainer {
  private readonly services = new Map<string, ProvidedServiceRecord>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<() => void>();
  private readonly interceptors = new Map<string, InterceptorEntry[]>();
  private readonly pluginOwnedDisposers = new Map<string, Set<Disposer>>();

  provide<T>(
    key: ServiceKey<T> | string,
    implementation: T,
    ownerPluginId?: string
  ): Disposer {
    const id = normalizeServiceId(key);
    const record: ProvidedServiceRecord = {
      id,
      ownerPluginId,
      value: implementation,
    };
    this.services.set(id, record);
    this.notify(id);
    return () => {
      if (this.services.get(id) === record) {
        this.services.delete(id);
        this.notify(id);
      }
    };
  }

  get<T>(key: ServiceKey<T> | string): T | undefined {
    return this.inject(key);
  }

  inject<T>(key: ServiceKey<T> | string): T | undefined;
  inject<TResolved = InjectedServicesRecord>(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    effect: (resolved: TResolved) => void | Disposer,
    ownerPluginId?: string
  ): Disposer;
  inject<T, TResolved = InjectedServicesRecord>(
    keyOrDeps:
      | ServiceKey<T>
      | string
      | ReadonlyArray<ServiceKey<unknown> | string>,
    effect?: (resolved: TResolved) => void | Disposer,
    ownerPluginId?: string
  ): T | undefined | Disposer {
    if (!Array.isArray(keyOrDeps)) {
      const id = normalizeServiceId(keyOrDeps as ServiceKey<T> | string);
      return this.services.get(id)?.value as T | undefined;
    }

    if (typeof effect !== 'function') {
      throw new Error(
        'ServiceContainer.inject(deps, effect) requires an effect callback when deps is an array'
      );
    }

    const depIds = keyOrDeps.map((dep) => normalizeServiceId(dep));
    let currentCleanup: void | Disposer;
    let disposed = false;

    const evaluate = () => {
      if (disposed) {
        return;
      }
      if (typeof currentCleanup === 'function') {
        const prev = currentCleanup;
        currentCleanup = undefined;
        try {
          prev();
        } catch {
          // Isolate effect cleanup errors.
        }
      }
      if (depIds.every((id) => this.services.has(id))) {
        const resolved: Record<string, unknown> = {};
        for (const id of depIds) {
          resolved[id] = this.services.get(id)?.value;
        }
        Object.defineProperty(resolved, Symbol.iterator, {
          enumerable: false,
          value: function* () {
            for (const id of depIds) {
              yield resolved[id];
            }
          },
        });
        try {
          currentCleanup = effect(resolved as unknown as TResolved);
        } catch {
          // Isolate effect execution errors.
        }
      }
    };

    const unsubs = depIds.map((id) => this.onServiceChange(id, evaluate));
    evaluate();

    const disposer: Disposer = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const unsub of unsubs) {
        unsub();
      }
      if (typeof currentCleanup === 'function') {
        const prev = currentCleanup;
        currentCleanup = undefined;
        try {
          prev();
        } catch {
          // Isolate cleanup errors.
        }
      }
      if (ownerPluginId) {
        this.pluginOwnedDisposers.get(ownerPluginId)?.delete(disposer);
      }
    };

    if (ownerPluginId) {
      let owned = this.pluginOwnedDisposers.get(ownerPluginId);
      if (!owned) {
        owned = new Set();
        this.pluginOwnedDisposers.set(ownerPluginId, owned);
      }
      owned.add(disposer);
    }

    return disposer;
  }

  require<T>(key: ServiceKey<T> | string): T {
    const value = this.inject(key);
    if (value === undefined) {
      throw new Error(
        `Required plugin service "${normalizeServiceId(key)}" is not available`
      );
    }
    return value;
  }

  has<T>(key: ServiceKey<T> | string): boolean {
    return this.services.has(normalizeServiceId(key));
  }

  intercept<TPayload = unknown, TResult = TPayload>(
    hookName: string,
    fn:
      | WaterfallInterceptor<TPayload, TResult>
      | ServiceDecorator<TPayload, TResult>,
    order = 0,
    ownerPluginId?: string
  ): Disposer {
    if (this.services.has(hookName) && fn.length <= 1) {
      const prevRecord = this.services.get(hookName)!;
      const decoratedValue = (fn as ServiceDecorator<unknown, unknown>)(
        prevRecord.value
      );
      const nextRecord: ProvidedServiceRecord = {
        id: hookName,
        ownerPluginId: ownerPluginId ?? prevRecord.ownerPluginId,
        value: decoratedValue,
      };
      this.services.set(hookName, nextRecord);
      this.notify(hookName);
      const disposer: Disposer = () => {
        if (this.services.get(hookName) === nextRecord) {
          this.services.set(hookName, prevRecord);
          this.notify(hookName);
        }
        if (ownerPluginId) {
          this.pluginOwnedDisposers.get(ownerPluginId)?.delete(disposer);
        }
      };
      if (ownerPluginId) {
        let owned = this.pluginOwnedDisposers.get(ownerPluginId);
        if (!owned) {
          owned = new Set();
          this.pluginOwnedDisposers.set(ownerPluginId, owned);
        }
        owned.add(disposer);
      }
      return disposer;
    }

    let list = this.interceptors.get(hookName);
    if (!list) {
      list = [];
      this.interceptors.set(hookName, list);
    }
    const wrappedFn: WaterfallInterceptor<unknown, unknown> =
      fn.length <= 1
        ? async (payload, next) => {
            const transformed = await (
              fn as (value: unknown) => unknown | Promise<unknown>
            )(payload);
            return await next(
              transformed !== undefined ? transformed : payload
            );
          }
        : (fn as WaterfallInterceptor<unknown, unknown>);
    const entry: InterceptorEntry = {
      ownerPluginId,
      order,
      fn: wrappedFn,
    };
    list.push(entry);
    list.sort((a, b) => a.order - b.order);

    const disposer: Disposer = () => {
      const current = this.interceptors.get(hookName);
      if (!current) {
        return;
      }
      const idx = current.indexOf(entry);
      if (idx !== -1) {
        current.splice(idx, 1);
      }
      if (current.length === 0) {
        this.interceptors.delete(hookName);
      }
      if (ownerPluginId) {
        this.pluginOwnedDisposers.get(ownerPluginId)?.delete(disposer);
      }
    };

    if (ownerPluginId) {
      let owned = this.pluginOwnedDisposers.get(ownerPluginId);
      if (!owned) {
        owned = new Set();
        this.pluginOwnedDisposers.set(ownerPluginId, owned);
      }
      owned.add(disposer);
    }

    return disposer;
  }

  hasInterceptors(hookName: string): boolean {
    const entries = this.interceptors.get(hookName);
    return Boolean(entries && entries.length > 0);
  }

  async runWaterfall<TPayload, TResult = TPayload>(
    hookName: string,
    initialPayload: TPayload,
    terminal: (payload: TPayload) => Promise<TResult> | TResult = (payload) =>
      payload as unknown as TResult,
    perHookTimeoutMs = 1500
  ): Promise<TResult> {
    const chain = [...(this.interceptors.get(hookName) ?? [])];
    const dispatch = async (
      index: number,
      currentPayload: TPayload
    ): Promise<TResult> => {
      if (index >= chain.length) {
        return await terminal(currentPayload);
      }
      const current = chain[index]!;
      let nextCalled = false;
      const invokeHook = current.fn(currentPayload, async (nextPayload) => {
        if (nextCalled) {
          throw new Error('waterfall next() called multiple times');
        }
        nextCalled = true;
        return await dispatch(
          index + 1,
          (nextPayload !== undefined ? nextPayload : currentPayload) as TPayload
        );
      }) as Promise<TResult>;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutFallback = new Promise<TResult>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          if (!nextCalled) {
            dispatch(index + 1, currentPayload).then(resolve, reject);
          }
        }, perHookTimeoutMs);
      });

      try {
        return await Promise.race([invokeHook, timeoutFallback]);
      } catch {
        if (!nextCalled) {
          return await dispatch(index + 1, currentPayload);
        }
        throw new Error(`Waterfall hook "${hookName}" failed after next()`);
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    };

    return await dispatch(0, initialPayload);
  }

  async emitParallel<TPayload>(
    hookName: string,
    payload: TPayload
  ): Promise<void> {
    const chain = [...(this.interceptors.get(hookName) ?? [])];
    await Promise.allSettled(
      chain.map((entry) =>
        Promise.resolve().then(() =>
          entry.fn(payload, async (nextPayload) => nextPayload ?? payload)
        )
      )
    );
  }

  onServiceChange<T>(
    key: ServiceKey<T> | string,
    listener: () => void
  ): Disposer {
    const id = normalizeServiceId(key);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  subscribe(listener: () => void): Disposer {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  disposeByPlugin(pluginId: string): number {
    let removedCount = 0;

    const ownedDisposers = this.pluginOwnedDisposers.get(pluginId);
    if (ownedDisposers) {
      this.pluginOwnedDisposers.delete(pluginId);
      for (const disposer of Array.from(ownedDisposers)) {
        disposer();
        removedCount += 1;
      }
    }

    for (const [hookName, entries] of this.interceptors.entries()) {
      const before = entries.length;
      const filtered = entries.filter((e) => e.ownerPluginId !== pluginId);
      removedCount += before - filtered.length;
      if (filtered.length === 0) {
        this.interceptors.delete(hookName);
      } else if (filtered.length !== before) {
        this.interceptors.set(hookName, filtered);
      }
    }

    const removedIds: string[] = [];
    for (const [id, record] of this.services.entries()) {
      if (record.ownerPluginId === pluginId) {
        this.services.delete(id);
        removedIds.push(id);
        removedCount += 1;
      }
    }
    for (const id of removedIds) {
      this.notify(id);
    }
    return removedCount;
  }

  disposePlugin(pluginId: string): number {
    return this.disposeByPlugin(pluginId);
  }

  clear(): void {
    for (const disposers of this.pluginOwnedDisposers.values()) {
      for (const disposer of Array.from(disposers)) {
        disposer();
      }
    }
    this.pluginOwnedDisposers.clear();
    this.interceptors.clear();
    const ids = Array.from(this.services.keys());
    this.services.clear();
    for (const id of ids) {
      this.notify(id);
    }
  }

  private notify(id: string): void {
    const set = this.listeners.get(id);
    if (set) {
      for (const listener of Array.from(set)) {
        try {
          listener();
        } catch {
          // Isolate listener failures.
        }
      }
    }
    for (const listener of Array.from(this.globalListeners)) {
      try {
        listener();
      } catch {
        // Isolate listener failures.
      }
    }
  }
}

/**
 * Tracks reversible side effects (disposers) for one plugin activation fiber
 * and tears them down in LIFO order on deactivation/HMR.
 */
export class EffectScope {
  private readonly disposers: Disposer[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  addDisposer(disposer: Disposer): Disposer {
    if (this.disposed) {
      try {
        disposer();
      } catch {
        // Ignore late disposer errors.
      }
      return () => {};
    }
    this.disposers.push(disposer);
    return () => {
      const idx = this.disposers.indexOf(disposer);
      if (idx !== -1) {
        this.disposers.splice(idx, 1);
        try {
          disposer();
        } catch {
          // Isolate disposer errors.
        }
      }
    };
  }

  effect(setup: () => void | Disposer): Disposer {
    if (this.disposed) {
      return () => {};
    }
    const cleanup = setup();
    if (typeof cleanup === 'function') {
      return this.addDisposer(cleanup);
    }
    return () => {};
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const pending = this.disposers.splice(0, this.disposers.length).reverse();
    for (const disposer of pending) {
      try {
        disposer();
      } catch {
        // Ensure every disposer runs even if one throws.
      }
    }
  }
}

const GLOBAL_SERVICE_CONTAINER_SYMBOL = Symbol.for(
  'vibex.plugin-sdk.serviceContainer'
);

function getOrCreateGlobalServiceContainer(): ServiceContainer {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const sharedHost = globalRecord.__VIBEX_SHARED_PLUGIN_HOST__ as
    | { serviceContainer?: ServiceContainer }
    | undefined;
  if (
    sharedHost?.serviceContainer &&
    typeof sharedHost.serviceContainer.provide === 'function' &&
    typeof sharedHost.serviceContainer.inject === 'function'
  ) {
    globalRecord[GLOBAL_SERVICE_CONTAINER_SYMBOL] =
      sharedHost.serviceContainer;
    return sharedHost.serviceContainer;
  }
  const existing = globalRecord[GLOBAL_SERVICE_CONTAINER_SYMBOL] as
    | ServiceContainer
    | undefined;
  if (
    existing &&
    typeof existing.provide === 'function' &&
    typeof existing.inject === 'function'
  ) {
    if (sharedHost && !sharedHost.serviceContainer) {
      sharedHost.serviceContainer = existing;
    }
    return existing;
  }
  const created = new ServiceContainer();
  globalRecord[GLOBAL_SERVICE_CONTAINER_SYMBOL] = created;
  if (sharedHost) {
    sharedHost.serviceContainer = created;
  }
  return created;
}

export const serviceContainer: ServiceContainer =
  getOrCreateGlobalServiceContainer();
export const globalServices: ServiceContainer = serviceContainer;
