import type { JsonValue, PluginContext } from './protocol.js';
export interface Disposable {
    dispose(): void | Promise<void>;
}
export interface PluginHostClient {
    call<T extends JsonValue = JsonValue>(capability: string, operation: string, input?: JsonValue): Promise<T>;
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
export declare function normalizePluginContext(context: Partial<PluginContext> & Pick<PluginContext, "pluginId" | "pluginVersion" | "generation">): PluginContext;
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
export declare function activatePluginWorker(definition: PluginWorkerDefinition, environment: Omit<PluginWorkerEnvironment, 'signal'>): Promise<ActivatedPluginWorker>;
export declare class PluginSdkError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
