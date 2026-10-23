import type { Disposer } from './registry.js';
export interface ServiceKey<T> {
    readonly id: string;
    readonly __type?: T;
}
export declare function createServiceKey<T>(id: string): ServiceKey<T>;
export type InjectedServicesRecord = Record<string, unknown> & Iterable<unknown>;
export type ServiceDecorator<TService = unknown, TResult = TService> = (previousService: TService) => TResult;
export type WaterfallInterceptor<TPayload, TResult> = (payload: TPayload, next: (modifiedPayload: TPayload) => Promise<TResult>) => Promise<TResult>;
/**
 * Cordis-inspired cross-plugin service container with owner-scoped auto-revocation,
 * multi-dependency reactive `inject(deps, effect)`, and onion-model waterfall interceptors
 * with per-hook timeout degradation.
 */
export declare class ServiceContainer {
    private readonly services;
    private readonly listeners;
    private readonly globalListeners;
    private readonly interceptors;
    private readonly pluginOwnedDisposers;
    provide<T>(key: ServiceKey<T> | string, implementation: T, ownerPluginId?: string): Disposer;
    get<T>(key: ServiceKey<T> | string): T | undefined;
    inject<T>(key: ServiceKey<T> | string): T | undefined;
    inject<TResolved = InjectedServicesRecord>(deps: ReadonlyArray<ServiceKey<unknown> | string>, effect: (resolved: TResolved) => void | Disposer, ownerPluginId?: string): Disposer;
    require<T>(key: ServiceKey<T> | string): T;
    has<T>(key: ServiceKey<T> | string): boolean;
    intercept<TPayload = unknown, TResult = TPayload>(hookName: string, fn: WaterfallInterceptor<TPayload, TResult> | ServiceDecorator<TPayload, TResult>, order?: number, ownerPluginId?: string): Disposer;
    hasInterceptors(hookName: string): boolean;
    runWaterfall<TPayload, TResult = TPayload>(hookName: string, initialPayload: TPayload, terminal?: (payload: TPayload) => Promise<TResult> | TResult, perHookTimeoutMs?: number): Promise<TResult>;
    emitParallel<TPayload>(hookName: string, payload: TPayload): Promise<void>;
    onServiceChange<T>(key: ServiceKey<T> | string, listener: () => void): Disposer;
    subscribe(listener: () => void): Disposer;
    disposeByPlugin(pluginId: string): number;
    disposePlugin(pluginId: string): number;
    clear(): void;
    private notify;
}
/**
 * Tracks reversible side effects (disposers) for one plugin activation fiber
 * and tears them down in LIFO order on deactivation/HMR.
 */
export declare class EffectScope {
    private readonly disposers;
    private disposed;
    get isDisposed(): boolean;
    addDisposer(disposer: Disposer): Disposer;
    effect(setup: () => void | Disposer): Disposer;
    dispose(): void;
}
export declare const serviceContainer: ServiceContainer;
export declare const globalServices: ServiceContainer;
