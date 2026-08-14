export declare const PLUGIN_DEV_PROTOCOL_VERSION: "1.0";
export declare function resolvePluginDevConnection(args: readonly string[], environment?: Record<string, string | undefined>): {
    endpoint: string;
    token: string;
};
export interface PluginIdentity {
    publisher: string;
    id: string;
}
export interface PackageExpectation {
    publisher: string;
    pluginId: string;
    version: string;
    packageDigest: string;
}
export interface InstallLinkedRequest {
    sourcePath: string;
    expected: PackageExpectation;
}
export interface ActivatedGeneration {
    protocolVersion: typeof PLUGIN_DEV_PROTOCOL_VERSION;
    plugin: PluginIdentity;
    generation: number;
    packageDigest: string;
    state: "active";
}
export interface PluginDoctorReport {
    protocolVersion: typeof PLUGIN_DEV_PROTOCOL_VERSION;
    plugin: PluginIdentity;
    installation: unknown;
    activation: unknown;
    grants: unknown[];
    runtimes: unknown[];
    surfaces: unknown[];
    agentBindings: unknown[];
    recentCrashes: unknown[];
    diagnostics: Array<{
        code: string;
        severity: "error" | "warning";
        message: string;
    }>;
}
export declare class PluginDevHostError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly diagnosticId?: string | undefined;
    readonly publishedGeneration?: number | undefined;
    constructor(code: string, message: string, retryable: boolean, diagnosticId?: string | undefined, publishedGeneration?: number | undefined);
}
export declare class PluginDevHostClient {
    #private;
    constructor(options: {
        endpoint: string;
        token: string;
    });
    installLinked(request: InstallLinkedRequest): Promise<ActivatedGeneration>;
    reloadCandidate(plugin: PluginIdentity, request: {
        sourcePath: string;
        expectedPackageDigest: string;
    }): Promise<ActivatedGeneration>;
    uninstallLinked(plugin: PluginIdentity, retainData: boolean): Promise<{
        protocolVersion: typeof PLUGIN_DEV_PROTOCOL_VERSION;
        plugin: PluginIdentity;
        removed: true;
        dataRetention: "retained" | "deleted";
    }>;
    doctor(plugin: PluginIdentity): Promise<PluginDoctorReport>;
}
