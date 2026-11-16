import type { DimoPluginManifest } from "@dimoai/plugin-sdk";
export interface Diagnostic {
    code: string;
    severity: "error" | "warning";
    message: string;
    path?: string;
}
export interface ValidationResult {
    valid: boolean;
    manifest?: DimoPluginManifest;
    diagnostics: Diagnostic[];
}
export declare function validatePlugin(root: string): Promise<ValidationResult>;
