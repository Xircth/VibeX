export declare function watchPluginSources(root: string, options: {
    signal: AbortSignal;
    reload: () => Promise<void>;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    debounceMs?: number;
}): Promise<void>;
