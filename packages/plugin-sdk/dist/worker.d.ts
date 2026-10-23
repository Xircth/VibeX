import type { JsonValue, PluginContext } from './protocol.js';
import type { Disposer } from './registry.js';
import { type ServiceContainer, type ServiceKey, type WaterfallInterceptor } from './services.js';
export interface Disposable {
    dispose(): void | Promise<void>;
}
export interface PluginHostClient {
    call<T extends JsonValue = JsonValue>(capability: string, operation: string, input?: JsonValue): Promise<T>;
}
export interface PluginWorkerServiceRegistry {
    provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer;
    get<T>(key: ServiceKey<T> | string): T | undefined;
    inject<T>(key: ServiceKey<T> | string): T | undefined;
    inject(deps: ReadonlyArray<ServiceKey<unknown> | string>, effect: (resolved: any) => void | Disposer): Disposer;
    require<T>(key: ServiceKey<T> | string): T;
    has<T>(key: ServiceKey<T> | string): boolean;
    intercept<TPayload = unknown, TResult = unknown>(hookName: string, fn: WaterfallInterceptor<TPayload, TResult> | ((previousService: any) => any), order?: number): Disposer;
    runWaterfall<TPayload, TResult>(hookName: string, initialPayload: TPayload, terminal: (payload: TPayload) => Promise<TResult>, perHookTimeoutMs?: number): Promise<TResult>;
    subscribe(listener: () => void): Disposer;
}
export declare function createWorkerServiceRegistry(pluginId: string, container?: ServiceContainer): PluginWorkerServiceRegistry;
export interface PluginWorkerEnvironment {
    context: PluginContext;
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
export declare function normalizePluginContext(context: Partial<PluginContext> & Pick<PluginContext, 'pluginId' | 'pluginVersion' | 'generation'>): PluginContext;
export type PluginHandler = (input: JsonValue, environment: PluginWorkerEnvironment) => JsonValue | Promise<JsonValue>;
export interface PluginWorkerRegistrar {
    handle(id: string, handler: PluginHandler): void;
    onDispose(disposable: Disposable | (() => void | Promise<void>)): void;
}
export interface PluginWorkerDefinition {
    readonly apiVersion: '1.0';
    readonly setup: (registrar: PluginWorkerRegistrar, environment: PluginWorkerEnvironment) => void | Disposable | Promise<void | Disposable>;
}
export interface ActivatedPluginWorker extends Disposable {
    readonly handlers: readonly string[];
    invoke(handler: string, input: JsonValue): Promise<JsonValue>;
}
export declare function definePluginWorker(setup: PluginWorkerDefinition['setup']): PluginWorkerDefinition;
export declare function activatePluginWorker(definition: PluginWorkerDefinition, environment: Omit<PluginWorkerEnvironment, 'signal' | 'services'> & {
    services?: PluginWorkerServiceRegistry;
}): Promise<ActivatedPluginWorker>;
export declare class PluginSdkError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
