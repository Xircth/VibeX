import { type HostFlags, type HostSession } from "./hostSession.js";
export declare const RUN_SCRIPTS: readonly ["server", "dev", "build", "test"];
export type RunScript = (typeof RUN_SCRIPTS)[number];
export type RunInvocation = {
    script: RunScript;
    host: HostFlags;
    positional: string[];
    hostJourney: boolean;
};
export declare function parseRunInvocation(args: readonly string[]): RunInvocation;
export declare function bindHostServer(options: {
    flags: HostFlags;
    saved?: HostSession | null;
    ping?: (session: HostSession) => Promise<boolean>;
    save?: (session: HostSession) => void;
}): Promise<HostSession>;
export declare function runPluginDev(root: string, options?: {
    log?: (message: string) => void;
}): Promise<void>;
export declare function runPluginBuild(root: string): Promise<string>;
export declare function runPluginTest(root: string, options?: {
    host?: boolean;
}): Promise<void>;
