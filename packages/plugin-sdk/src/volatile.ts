import type { JsonValue } from './protocol.js';
import type { Disposer } from './registry.js';

export type VolatileListener<T> = (next: T, prev: T) => void;
export type VolatileEqualityFn<T> = (a: T, b: T) => boolean;

/**
 * DSH-inspired fine-grained reactive configuration reference (`Volatile<T>`).
 *
 * Allows Worker and UI plugins to read live configuration values (`get()` /
 * `.value` / `.current`), derive fine-grained reactive slices (`select(fn)` /
 * `map(fn)`), and subscribe to in-place updates (`subscribe(fn)` /
 * `onChange(fn)`) when `config.json` changes—without requiring a full plugin
 * generation rebuild or process restart.
 */
export interface Volatile<T> {
  /** Reads the latest snapshot value. */
  get(): T;
  /** Property getter alias for `get()`. */
  readonly value: T;
  /** DSH-compatible property getter alias for `get()`. */
  readonly current: T;
  /**
   * Projects a fine-grained reactive slice from this `Volatile<T>`.
   * Listeners on the derived `Volatile<U>` are notified only when the selected
   * slice changes according to `isEqual` (defaults to deep structural equality).
   */
  select<U>(
    selector: (value: T) => U,
    isEqual?: VolatileEqualityFn<U>
  ): Volatile<U>;
  /** DSH-compatible alias for `select(selector, isEqual)`. */
  map<U>(
    selector: (value: T) => U,
    isEqual?: VolatileEqualityFn<U>
  ): Volatile<U>;
  /**
   * Subscribes to value updates. Returns a disposer function.
   */
  subscribe(listener: VolatileListener<T>): Disposer;
  /** DSH-compatible alias for `subscribe(listener)`. */
  onChange(listener: VolatileListener<T>): Disposer;
}

export interface MutableVolatile<T> extends Volatile<T> {
  /**
   * Updates the current value and notifies subscribers if the value changed.
   * Returns `true` when the new value differed from the previous value.
   */
  set(next: T): boolean;
  /**
   * Updates the current value using a pure updater function.
   */
  update(updater: (current: T) => T): boolean;
}

/**
 * Deep structural equality check for JSON-compatible config values.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!structuralEqual(objA[key], objB[key])) return false;
  }
  return true;
}

export function createVolatile<T>(
  initialValue: T,
  isEqual: VolatileEqualityFn<T> = structuralEqual
): MutableVolatile<T> {
  let current = initialValue;
  const listeners = new Set<VolatileListener<T>>();

  const self: MutableVolatile<T> = {
    get(): T {
      return current;
    },
    get value(): T {
      return current;
    },
    get current(): T {
      return current;
    },
    set(next: T): boolean {
      if (isEqual(current, next)) {
        return false;
      }
      const prev = current;
      current = next;
      for (const listener of [...listeners]) {
        try {
          listener(current, prev);
        } catch {
          // Isolate listener errors so one faulty subscriber cannot break others.
        }
      }
      return true;
    },
    update(updater: (current: T) => T): boolean {
      return self.set(updater(current));
    },
    select<U>(
      selector: (value: T) => U,
      sliceEqual: VolatileEqualityFn<U> = structuralEqual
    ): Volatile<U> {
      return createDerivedVolatile(self, selector, sliceEqual);
    },
    map<U>(
      selector: (value: T) => U,
      sliceEqual: VolatileEqualityFn<U> = structuralEqual
    ): Volatile<U> {
      return createDerivedVolatile(self, selector, sliceEqual);
    },
    subscribe(listener: VolatileListener<T>): Disposer {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onChange(listener: VolatileListener<T>): Disposer {
      return self.subscribe(listener);
    },
  };

  return self;
}

function createDerivedVolatile<T, U>(
  source: Volatile<T>,
  selector: (value: T) => U,
  isEqual: VolatileEqualityFn<U>
): Volatile<U> {
  const readSlice = (): U => selector(source.get());

  const derived: Volatile<U> = {
    get(): U {
      return readSlice();
    },
    get value(): U {
      return readSlice();
    },
    get current(): U {
      return readSlice();
    },
    select<V>(
      nextSelector: (value: U) => V,
      nextEqual: VolatileEqualityFn<V> = structuralEqual
    ): Volatile<V> {
      return createDerivedVolatile(
        source,
        (rootValue) => nextSelector(selector(rootValue)),
        nextEqual
      );
    },
    map<V>(
      nextSelector: (value: U) => V,
      nextEqual: VolatileEqualityFn<V> = structuralEqual
    ): Volatile<V> {
      return derived.select(nextSelector, nextEqual);
    },
    subscribe(listener: VolatileListener<U>): Disposer {
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
    onChange(listener: VolatileListener<U>): Disposer {
      return derived.subscribe(listener);
    },
  };

  return derived;
}

const VOLATILE_CONFIG_STORE_KEY = Symbol.for(
  'vibex.plugin-sdk.volatileConfigStore'
);

type VolatileConfigMap = Map<string, MutableVolatile<Record<string, JsonValue>>>;

function getGlobalVolatileConfigMap(): VolatileConfigMap {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[VOLATILE_CONFIG_STORE_KEY] as VolatileConfigMap | undefined;
  if (!(store instanceof Map)) {
    store = new Map();
    g[VOLATILE_CONFIG_STORE_KEY] = store;
  }
  return store;
}

function normalizeConfigObject(
  input: unknown
): Record<string, JsonValue> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(input as Record<string, JsonValue>) };
  }
  return {};
}

/**
 * Returns (or creates) the shared `MutableVolatile` configuration cell for a
 * given `pluginId`.
 */
export function getPluginVolatileConfig<
  T extends Record<string, unknown> = Record<string, JsonValue>,
>(pluginId: string, defaults?: T): MutableVolatile<T> {
  const store = getGlobalVolatileConfigMap();
  let cell = store.get(pluginId);
  if (!cell) {
    cell = createVolatile<Record<string, JsonValue>>(
      normalizeConfigObject(defaults)
    );
    store.set(pluginId, cell);
  } else if (defaults && Object.keys(cell.get()).length === 0) {
    const merged = {
      ...normalizeConfigObject(defaults),
      ...cell.get(),
    };
    cell.set(merged);
  }
  return cell as unknown as MutableVolatile<T>;
}

/**
 * Pushes a live configuration update into the target plugin's `Volatile` cell
 * without restarting or rebuilding the plugin generation.
 */
export function notifyPluginConfigUpdated(
  pluginId: string,
  nextConfig: unknown
): boolean {
  const cell = getPluginVolatileConfig(pluginId);
  return cell.set(normalizeConfigObject(nextConfig));
}

export function clearPluginVolatileConfig(pluginId?: string): void {
  const store = getGlobalVolatileConfigMap();
  if (pluginId) {
    store.delete(pluginId);
  } else {
    store.clear();
  }
}
