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
    select<U>(selector: (value: T) => U, isEqual?: VolatileEqualityFn<U>): Volatile<U>;
    /** DSH-compatible alias for `select(selector, isEqual)`. */
    map<U>(selector: (value: T) => U, isEqual?: VolatileEqualityFn<U>): Volatile<U>;
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
export declare function structuralEqual(a: unknown, b: unknown): boolean;
export declare function createVolatile<T>(initialValue: T, isEqual?: VolatileEqualityFn<T>): MutableVolatile<T>;
/**
 * Returns (or creates) the shared `MutableVolatile` configuration cell for a
 * given `pluginId`.
 */
export declare function getPluginVolatileConfig<T extends Record<string, unknown> = Record<string, JsonValue>>(pluginId: string, defaults?: T): MutableVolatile<T>;
/**
 * Pushes a live configuration update into the target plugin's `Volatile` cell
 * without restarting or rebuilding the plugin generation.
 */
export declare function notifyPluginConfigUpdated(pluginId: string, nextConfig: unknown): boolean;
export declare function clearPluginVolatileConfig(pluginId?: string): void;
