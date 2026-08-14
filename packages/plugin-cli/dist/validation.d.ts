import type { VibeXPluginManifest } from '@vibex/plugin-sdk';
export interface Diagnostic {
    code: string;
    severity: 'error' | 'warning';
    message: string;
    path?: string;
}
export interface ValidationResult {
    valid: boolean;
    manifest?: VibeXPluginManifest;
    diagnostics: Diagnostic[];
}
export declare function validatePlugin(root: string): Promise<ValidationResult>;
