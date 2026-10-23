export function createServiceKey(id) {
    return Object.freeze({ id });
}
function normalizeServiceId(key) {
    return typeof key === 'string' ? key : key.id;
}
/**
 * Cordis-inspired cross-plugin service container with owner-scoped auto-revocation,
 * multi-dependency reactive `inject(deps, effect)`, and onion-model waterfall interceptors
 * with per-hook timeout degradation.
 */
export class ServiceContainer {
    services = new Map();
    listeners = new Map();
    globalListeners = new Set();
    interceptors = new Map();
    pluginOwnedDisposers = new Map();
    provide(key, implementation, ownerPluginId) {
        const id = normalizeServiceId(key);
        const record = {
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
    get(key) {
        return this.inject(key);
    }
    inject(keyOrDeps, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect, ownerPluginId) {
        if (!Array.isArray(keyOrDeps)) {
            const id = normalizeServiceId(keyOrDeps);
            return this.services.get(id)?.value;
        }
        if (typeof effect !== 'function') {
            throw new Error('ServiceContainer.inject(deps, effect) requires an effect callback when deps is an array');
        }
        const depIds = keyOrDeps.map((dep) => normalizeServiceId(dep));
        let currentCleanup;
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
                }
                catch {
                    // Isolate effect cleanup errors.
                }
            }
            if (depIds.every((id) => this.services.has(id))) {
                const resolved = {};
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
                    currentCleanup = effect(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    resolved);
                }
                catch {
                    // Isolate effect execution errors.
                }
            }
        };
        const unsubs = depIds.map((id) => this.onServiceChange(id, evaluate));
        evaluate();
        const disposer = () => {
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
                }
                catch {
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
    require(key) {
        const value = this.inject(key);
        if (value === undefined) {
            throw new Error(`Required plugin service "${normalizeServiceId(key)}" is not available`);
        }
        return value;
    }
    has(key) {
        return this.services.has(normalizeServiceId(key));
    }
    intercept(hookName, fn, order = 0, ownerPluginId) {
        if (this.services.has(hookName) && fn.length <= 1) {
            const prevRecord = this.services.get(hookName);
            const decoratedValue = 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fn(prevRecord.value);
            const nextRecord = {
                id: hookName,
                ownerPluginId: ownerPluginId ?? prevRecord.ownerPluginId,
                value: decoratedValue,
            };
            this.services.set(hookName, nextRecord);
            this.notify(hookName);
            const disposer = () => {
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
        const wrappedFn = fn.length <= 1
            ? async (payload, next) => {
                const transformed = await fn(payload);
                return await next(transformed !== undefined ? transformed : payload);
            }
            : fn;
        const entry = {
            ownerPluginId,
            order,
            fn: wrappedFn,
        };
        list.push(entry);
        list.sort((a, b) => a.order - b.order);
        const disposer = () => {
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
    hasInterceptors(hookName) {
        const entries = this.interceptors.get(hookName);
        return Boolean(entries && entries.length > 0);
    }
    async runWaterfall(hookName, initialPayload, terminal = (payload) => payload, perHookTimeoutMs = 1500) {
        const chain = [...(this.interceptors.get(hookName) ?? [])];
        const dispatch = async (index, currentPayload) => {
            if (index >= chain.length) {
                return await terminal(currentPayload);
            }
            const current = chain[index];
            let nextCalled = false;
            const invokeHook = current.fn(currentPayload, async (nextPayload) => {
                if (nextCalled) {
                    throw new Error('waterfall next() called multiple times');
                }
                nextCalled = true;
                return await dispatch(index + 1, (nextPayload !== undefined ? nextPayload : currentPayload));
            });
            let timeoutHandle;
            const timeoutFallback = new Promise((resolve, reject) => {
                timeoutHandle = setTimeout(() => {
                    if (!nextCalled) {
                        dispatch(index + 1, currentPayload).then(resolve, reject);
                    }
                }, perHookTimeoutMs);
            });
            try {
                return await Promise.race([invokeHook, timeoutFallback]);
            }
            catch {
                if (!nextCalled) {
                    return await dispatch(index + 1, currentPayload);
                }
                throw new Error(`Waterfall hook "${hookName}" failed after next()`);
            }
            finally {
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                }
            }
        };
        return await dispatch(0, initialPayload);
    }
    async emitParallel(hookName, payload) {
        const chain = [...(this.interceptors.get(hookName) ?? [])];
        await Promise.allSettled(chain.map((entry) => Promise.resolve().then(() => entry.fn(payload, async (nextPayload) => nextPayload ?? payload))));
    }
    onServiceChange(key, listener) {
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
    subscribe(listener) {
        this.globalListeners.add(listener);
        return () => {
            this.globalListeners.delete(listener);
        };
    }
    disposeByPlugin(pluginId) {
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
            }
            else if (filtered.length !== before) {
                this.interceptors.set(hookName, filtered);
            }
        }
        const removedIds = [];
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
    disposePlugin(pluginId) {
        return this.disposeByPlugin(pluginId);
    }
    clear() {
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
    notify(id) {
        const set = this.listeners.get(id);
        if (set) {
            for (const listener of Array.from(set)) {
                try {
                    listener();
                }
                catch {
                    // Isolate listener failures.
                }
            }
        }
        for (const listener of Array.from(this.globalListeners)) {
            try {
                listener();
            }
            catch {
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
    disposers = [];
    disposed = false;
    get isDisposed() {
        return this.disposed;
    }
    addDisposer(disposer) {
        if (this.disposed) {
            try {
                disposer();
            }
            catch {
                // Ignore late disposer errors.
            }
            return () => { };
        }
        this.disposers.push(disposer);
        return () => {
            const idx = this.disposers.indexOf(disposer);
            if (idx !== -1) {
                this.disposers.splice(idx, 1);
                try {
                    disposer();
                }
                catch {
                    // Isolate disposer errors.
                }
            }
        };
    }
    effect(setup) {
        if (this.disposed) {
            return () => { };
        }
        const cleanup = setup();
        if (typeof cleanup === 'function') {
            return this.addDisposer(cleanup);
        }
        return () => { };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const pending = this.disposers.splice(0, this.disposers.length).reverse();
        for (const disposer of pending) {
            try {
                disposer();
            }
            catch {
                // Ensure every disposer runs even if one throws.
            }
        }
    }
}
const GLOBAL_SERVICE_CONTAINER_SYMBOL = Symbol.for('vibex.plugin-sdk.serviceContainer');
function getOrCreateGlobalServiceContainer() {
    const globalRecord = globalThis;
    const sharedHost = globalRecord.__VIBEX_SHARED_PLUGIN_HOST__;
    if (sharedHost?.serviceContainer &&
        typeof sharedHost.serviceContainer.provide === 'function' &&
        typeof sharedHost.serviceContainer.inject === 'function') {
        globalRecord[GLOBAL_SERVICE_CONTAINER_SYMBOL] =
            sharedHost.serviceContainer;
        return sharedHost.serviceContainer;
    }
    const existing = globalRecord[GLOBAL_SERVICE_CONTAINER_SYMBOL];
    if (existing &&
        typeof existing.provide === 'function' &&
        typeof existing.inject === 'function') {
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
export const serviceContainer = getOrCreateGlobalServiceContainer();
export const globalServices = serviceContainer;
