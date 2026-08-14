import type { VibeXPluginManifest } from "@vibex/plugin-sdk";
import { type ActivatedGeneration, PluginDevHostClient, type PluginDoctorReport, type PluginIdentity } from "./hostClient.js";
export interface LinkedPackage {
    root: string;
    manifest: VibeXPluginManifest;
    identity: PluginIdentity;
    packageDigest: string;
}
export declare function inspectLinkedPackage(root: string): Promise<LinkedPackage>;
export declare function installLinkedPlugin(root: string, client: PluginDevHostClient): Promise<ActivatedGeneration>;
export declare function reloadLinkedPlugin(root: string, client: PluginDevHostClient): Promise<ActivatedGeneration>;
export declare function doctorPlugin(root: string, client: PluginDevHostClient): Promise<PluginDoctorReport>;
export declare function uninstallLinkedPlugin(root: string, client: PluginDevHostClient, retainData?: boolean): Promise<{
    protocolVersion: typeof import("./hostClient.js").PLUGIN_DEV_PROTOCOL_VERSION;
    plugin: PluginIdentity;
    removed: true;
    dataRetention: "retained" | "deleted";
}>;
