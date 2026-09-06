import type { VibeXPluginManifest } from "@vibex/plugin-sdk";
export type PluginIdentity = {
    publisher: string;
    id: string;
};
export interface LinkedPackage {
    root: string;
    manifest: VibeXPluginManifest;
    identity: PluginIdentity;
    packageDigest: string;
}
export declare function inspectLinkedPackage(root: string): Promise<LinkedPackage>;
