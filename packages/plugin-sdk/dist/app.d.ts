import type { JsonValue } from './protocol.js';
import { type VibeXPluginContext, type VibeXPluginDefinition } from './context.js';
export { createPluginContext, type CreatePluginContextOptions, definePlugin, defineVibeXPlugin, type HostCallTransport, isVibeXPluginDefinition, type PluginKvClient, type PluginNetworkFetchInput, type PluginNetworkFetchResponse, type PluginSettingsClient, setDefaultHostCallTransport, setDefaultWorkerInvokeTransport, type VibeXPluginContext, type VibeXPluginDefinition, type WorkerInvokeTransport, } from './context.js';
export interface PluginAppDomRoot {
    replaceChildren(...nodes: unknown[]): void;
    append(...nodes: unknown[]): void;
    appendChild<T>(node: T): T;
}
export interface PluginAppArtifactBridge {
    readonly name: string;
    readText(): Promise<{
        name: string;
        content: string;
        revision: string;
    }>;
    writeText(content: string, expectedRevision: string): Promise<{
        revision: string;
    }>;
}
export interface PluginAppBridge {
    readonly pluginId: string;
    readonly generation: number;
    invoke<T = JsonValue>(handler: string, input?: JsonValue): Promise<T>;
    subscribe(channel: string, listener: (payload: JsonValue) => void): () => void;
    ready(): void;
    readonly artifact?: PluginAppArtifactBridge;
}
export interface PluginAppSurfaceContext {
    readonly root: PluginAppDomRoot;
    readonly document?: unknown;
    readonly bridge: PluginAppBridge;
    readonly signal: AbortSignal;
}
export type PluginAppSurfaceSetup = (context: PluginAppSurfaceContext) => void | (() => void) | Promise<void | (() => void)>;
export interface PluginAppDefinition extends VibeXPluginDefinition {
    readonly mount: PluginAppSurfaceSetup;
}
export declare function definePluginApp(setup: PluginAppSurfaceSetup): PluginAppDefinition;
export declare function definePluginApp(definition: VibeXPluginDefinition): PluginAppDefinition;
export declare function definePluginApp(context: VibeXPluginContext): PluginAppDefinition;
