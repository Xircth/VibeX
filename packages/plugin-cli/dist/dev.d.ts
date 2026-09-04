export type PluginSourceWatcher = {
    close(): void;
};
export type CreatePluginSourceWatcher = (root: string, listener: () => void) => PluginSourceWatcher;
export declare function watchPluginSources(root: string, options: {
    signal: AbortSignal;
    reload: () => Promise<void>;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    debounceMs?: number;
    createWatcher?: CreatePluginSourceWatcher;
}): Promise<void>;
