import type { DimoPluginManifest } from "@dimoai/plugin-sdk";
export type PluginIdentity = {
    publisher: string;
    id: string;
};
export interface LinkedPackage {
    root: string;
    manifest: DimoPluginManifest;
    identity: PluginIdentity;
    packageDigest: string;
}
export declare function resolvePluginDirectoryInput(input?: string): string;
export declare function inspectLinkedPackage(root: string): Promise<LinkedPackage>;
