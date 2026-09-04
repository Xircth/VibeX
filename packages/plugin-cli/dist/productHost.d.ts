export declare function discoverProductHost(environment?: Record<string, string | undefined>): {
    url: string;
    token: string;
};
export declare function callProductHost<T>(command: string, args?: Record<string, unknown>): Promise<T>;
export declare function importLinkedOnProductHost(sourcePath: string, plugin: {
    publisher: string;
    id: string;
}): Promise<{
    plugin: {
        publisher: string;
        id: string;
    };
    generation: number;
    packageDigest: string;
    queued: boolean;
}>;
export declare function enableOnProductHost(pluginId: string): Promise<unknown>;
export declare function uninstallOnProductHost(pluginId: string, retainData?: boolean): Promise<{
    pluginId?: string;
    dataRetention?: string;
}>;
export declare function doctorOnProductHost(pluginId: string): Promise<{
    plugin: {
        id: string;
    };
    diagnostics: {
        severity: "error";
        code: string;
        message: string;
    }[];
    installation: null;
} | {
    plugin: {
        id: string;
        packageDigest?: string;
        enabled?: boolean;
        warnings?: Array<{
            severity?: string;
            message?: string;
        }>;
    };
    diagnostics: {
        severity: "error" | "warning";
        code: string;
        message: string;
    }[];
    installation: {
        id: string;
        packageDigest?: string;
        enabled?: boolean;
        warnings?: Array<{
            severity?: string;
            message?: string;
        }>;
    };
}>;
