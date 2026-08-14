import type { JsonValue, PluginContext } from './protocol.js';
import type { PluginAppDefinition, VibeXAppBridge } from './app.js';
import { type ActivatedPluginWorker, type PluginHostClient, type PluginWorkerDefinition } from './worker.js';
export interface WorkerHarness extends ActivatedPluginWorker {
    readonly hostCalls: ReadonlyArray<{
        capability: string;
        operation: string;
        input: JsonValue;
    }>;
}
export declare function createWorkerHarness(definition: PluginWorkerDefinition, options?: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
}): Promise<WorkerHarness>;
export interface GenerationHarness {
    readonly generation: number;
    readonly handlers: readonly string[];
    invoke(handler: string, input: JsonValue): Promise<JsonValue>;
    activateCandidate(definition: PluginWorkerDefinition): Promise<number>;
    dispose(): Promise<void>;
}
export declare function createGenerationHarness(definition: PluginWorkerDefinition, options?: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
    requiredHandlers?: readonly string[];
}): Promise<GenerationHarness>;
export interface AppHarness {
    readonly bridge: VibeXAppBridge;
    readonly signal: AbortSignal;
    readonly ready: boolean;
    emit(channel: string, payload: JsonValue): void;
    revoke(): void;
    dispose(): Promise<void>;
}
export declare function createAppHarness(definition: PluginAppDefinition, options: {
    root: HTMLElement;
    pluginId?: string;
    generation?: number;
    invoke?: (handler: string, input: JsonValue) => Promise<JsonValue>;
    artifact?: {
        name: string;
        content: string;
        revision: string;
    };
}): Promise<AppHarness>;
