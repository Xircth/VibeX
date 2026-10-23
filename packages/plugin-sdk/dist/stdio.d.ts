import type { ServiceContainer } from "./services.js";
import { type PluginWorkerDefinition } from "./worker.js";
export declare function runStdioPluginWorker(definition: PluginWorkerDefinition): Promise<void>;
export interface SharedNodePluginSlotInfo {
    readonly pluginId: string;
    readonly generation: number;
    readonly cwd: string;
    readonly entrypoint: string;
    readonly disposed: boolean;
}
export interface SharedNodePluginHostRuntime {
    readonly slots: ReadonlyMap<string, SharedNodePluginSlotInfo>;
    readonly services: Map<string, unknown>;
    readonly serviceContainer?: ServiceContainer;
}
/**
 * Returns the shared Node plugin host runtime if the current worker is
 * executing inside VibeX's multiplexed `SharedNodeWorkerHost` process, or
 * `null` when running in a standalone single-plugin process.
 */
export declare function getSharedNodePluginHost(): SharedNodePluginHostRuntime | null;
/**
 * Returns `true` when this worker is executing inside the multiplexed
 * `SharedNodeWorkerHost` Node.js process.
 */
export declare function isSharedNodePluginHost(): boolean;
