import { type ViteDevServer } from "vite";
import type { PluginRemoteDeclaration } from "./remoteDev.js";
export declare function federationContainerName(remotes: readonly PluginRemoteDeclaration[]): string | null;
export declare function buildFederationRemotes(root: string, remotes: readonly PluginRemoteDeclaration[]): Promise<void>;
export declare function startFederationDevServer(options: {
    root: string;
    remotes: readonly PluginRemoteDeclaration[];
    port: number;
}): Promise<ViteDevServer>;
