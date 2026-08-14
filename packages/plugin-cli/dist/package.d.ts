export interface PackageLock {
    lockVersion: 1;
    packageDigest: string;
    files: Array<{
        path: string;
        size: number;
        sha256: string;
    }>;
    build: {
        cliVersion: string;
        reproducible: true;
    };
}
export declare function createPackageLock(root: string): Promise<PackageLock>;
export declare function packPlugin(root: string, output?: string): Promise<{
    output: string;
    lock: PackageLock;
}>;
export declare function defaultPluginName(path: string): string;
