export declare const PLUGIN_RC_NAME = "pluginrc";
export type HostSession = {
    url: string;
    token: string;
};
export type HostFlags = {
    url?: string;
    token?: string;
};
export declare function parseHostFlags(args: readonly string[]): {
    flags: HostFlags;
    rest: string[];
};
export declare function normalizeHostUrl(value: string): string;
export declare function hostSessionPath(home?: string): string;
export declare function saveHostSession(session: HostSession, file?: string): void;
export declare function loadHostSession(file?: string): HostSession | null;
export declare function clearHostSession(file?: string): void;
export declare function mergeHostSession(flags: HostFlags, saved: HostSession | null, discovered?: HostFlags): HostSession | null;
export declare function requireHostSession(session: HostSession | null): HostSession;
export declare function hostDataDirs(home?: string, environment?: Record<string, string | undefined>): string[];
export declare function discoverHostFiles(home?: string, environment?: Record<string, string | undefined>): HostFlags;
export declare function resolveHostSession(flags?: HostFlags, environment?: Record<string, string | undefined>, options?: {
    home?: string;
    sessionFile?: string;
}): HostSession | null;
