/**
 * Deep structural equality check for JSON-compatible config values.
 */
export function structuralEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (a === null ||
        b === null ||
        typeof a !== 'object' ||
        typeof b !== 'object') {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i += 1) {
            if (!structuralEqual(a[i], b[i]))
                return false;
        }
        return true;
    }
    const objA = a;
    const objB = b;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length)
        return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(objB, key))
            return false;
        if (!structuralEqual(objA[key], objB[key]))
            return false;
    }
    return true;
}
export function createVolatile(initialValue, isEqual = structuralEqual) {
    let current = initialValue;
    const listeners = new Set();
    const self = {
        get() {
            return current;
        },
        get value() {
            return current;
        },
        get current() {
            return current;
        },
        set(next) {
            if (isEqual(current, next)) {
                return false;
            }
            const prev = current;
            current = next;
            for (const listener of [...listeners]) {
                try {
                    listener(current, prev);
                }
                catch {
                    // Isolate listener errors so one faulty subscriber cannot break others.
                }
            }
            return true;
        },
        update(updater) {
            return self.set(updater(current));
        },
        select(selector, sliceEqual = structuralEqual) {
            return createDerivedVolatile(self, selector, sliceEqual);
        },
        map(selector, sliceEqual = structuralEqual) {
            return createDerivedVolatile(self, selector, sliceEqual);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        onChange(listener) {
            return self.subscribe(listener);
        },
    };
    return self;
}
function createDerivedVolatile(source, selector, isEqual) {
    const readSlice = () => selector(source.get());
    const derived = {
        get() {
            return readSlice();
        },
        get value() {
            return readSlice();
        },
        get current() {
            return readSlice();
        },
        select(nextSelector, nextEqual = structuralEqual) {
            return createDerivedVolatile(source, (rootValue) => nextSelector(selector(rootValue)), nextEqual);
        },
        map(nextSelector, nextEqual = structuralEqual) {
            return derived.select(nextSelector, nextEqual);
        },
        subscribe(listener) {
            let lastSlice = readSlice();
            return source.subscribe((nextRoot) => {
                const nextSlice = selector(nextRoot);
                if (isEqual(lastSlice, nextSlice)) {
                    return;
                }
                const prevSlice = lastSlice;
                lastSlice = nextSlice;
                listener(nextSlice, prevSlice);
            });
        },
        onChange(listener) {
            return derived.subscribe(listener);
        },
    };
    return derived;
}
const VOLATILE_CONFIG_STORE_KEY = Symbol.for('vibex.plugin-sdk.volatileConfigStore');
function getGlobalVolatileConfigMap() {
    const g = globalThis;
    let store = g[VOLATILE_CONFIG_STORE_KEY];
    if (!(store instanceof Map)) {
        store = new Map();
        g[VOLATILE_CONFIG_STORE_KEY] = store;
    }
    return store;
}
function normalizeConfigObject(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return { ...input };
    }
    return {};
}
/**
 * Returns (or creates) the shared `MutableVolatile` configuration cell for a
 * given `pluginId`.
 */
export function getPluginVolatileConfig(pluginId, defaults) {
    const store = getGlobalVolatileConfigMap();
    let cell = store.get(pluginId);
    if (!cell) {
        cell = createVolatile(normalizeConfigObject(defaults));
        store.set(pluginId, cell);
    }
    else if (defaults && Object.keys(cell.get()).length === 0) {
        const merged = {
            ...normalizeConfigObject(defaults),
            ...cell.get(),
        };
        cell.set(merged);
    }
    return cell;
}
/**
 * Pushes a live configuration update into the target plugin's `Volatile` cell
 * without restarting or rebuilding the plugin generation.
 */
export function notifyPluginConfigUpdated(pluginId, nextConfig) {
    const cell = getPluginVolatileConfig(pluginId);
    return cell.set(normalizeConfigObject(nextConfig));
}
export function clearPluginVolatileConfig(pluginId) {
    const store = getGlobalVolatileConfigMap();
    if (pluginId) {
        store.delete(pluginId);
    }
    else {
        store.clear();
    }
}
