/**
 * Color-theme contract shared by the Host, the SDK, and the plugin CLI.
 *
 * A theme names semantic color roles; the Host compiles the roles onto its
 * design tokens. The same object is a plugin manifest `themes[]` entry and the
 * file the Appearance editor imports and exports. `crates/plugins` mirrors
 * these rules for install-time validation.
 */
export type ThemeScheme = 'light' | 'dark';
export declare const THEME_COLOR_ROLES: readonly ["background", "foreground", "chrome", "surface", "popover", "mutedForeground", "subtleForeground", "faintForeground", "border", "borderSubtle", "control", "controlHover", "raisedControl", "raisedControlHover", "track", "accent", "success", "warning", "danger", "info", "terminalBackground", "terminalForeground", "syntaxKeyword", "syntaxFunction", "syntaxConstant", "syntaxString", "syntaxVariable", "syntaxComment", "syntaxTag", "syntaxPunctuation", "syntaxDeleted"];
export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export declare const REQUIRED_THEME_COLOR_ROLES: readonly ["background", "foreground"];
/** Roles painted as solid fills or text; translucency would composite into a
 * different color on every surface underneath. */
export declare const OPAQUE_THEME_COLOR_ROLES: readonly ["background", "foreground", "chrome", "surface", "popover", "accent", "terminalBackground"];
export type ThemeColors = {
    readonly background: string;
    readonly foreground: string;
} & {
    readonly [Role in ThemeColorRole]?: string;
};
export interface ThemeDefinition {
    readonly id: string;
    readonly label: string;
    readonly scheme: ThemeScheme;
    readonly colors: ThemeColors;
}
export declare const THEME_ID_PATTERN: RegExp;
export declare const THEME_LABEL_MAX_LENGTH = 64;
export interface ThemeIssue {
    readonly path: string;
    readonly message: string;
}
/** Expands `#rgb` and lowercases, so equal colors compare equal. */
export declare function normalizeThemeColor(value: string): string;
export declare function validateThemeDefinition(value: unknown, path?: string): ThemeIssue[];
export declare function validateThemeContributions(value: unknown, path?: string): ThemeIssue[];
/** Returns the normalized definition, or the issues that make it invalid. */
export declare function parseThemeDefinition(value: unknown): {
    readonly theme: ThemeDefinition;
    readonly issues?: undefined;
} | {
    readonly theme?: undefined;
    readonly issues: readonly ThemeIssue[];
};
