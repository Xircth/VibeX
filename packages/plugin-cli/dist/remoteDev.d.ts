export declare const DEV_REMOTE_SIDECAR = ".vibex-plugin/dev-remote.json";
export interface PluginRemoteDeclaration {
    name: string;
    entry: string;
    module: string;
}
export declare function remotesFromManifest(manifest: unknown): PluginRemoteDeclaration[];
export declare function readPluginRemotes(root: string): Promise<PluginRemoteDeclaration[]>;
export declare function startPluginRemoteDev(options: {
    root: string;
    remotes: PluginRemoteDeclaration[];
    signal: AbortSignal;
    onReady?: (entry: string) => void;
    onError?: (error: unknown) => void;
}): Promise<{
    entry: string;
    close(): Promise<void>;
} | null>;
