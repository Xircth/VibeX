/** Chrome slots that Batch 1 put on the stable surface. */
export declare const CHROME_KINDS: readonly ["app.command", "app.toolbar", "app.status", "app.composer.slash", "app.timeline.card", "app.settings.section"];
export type ChromeKind = (typeof CHROME_KINDS)[number];
/** Structure surfaces Batch 2 added. settings.page is preview, not a stable surface. */
export declare const STRUCTURE_KINDS: readonly ["app.panel", "app.tab", "app.kanban.view", "app.settings.page", "app.composer.action"];
export type StructureKind = (typeof STRUCTURE_KINDS)[number];
declare const HOST_JOURNEY_KINDS: readonly ["app.command", "app.toolbar", "app.status", "app.composer.slash", "app.timeline.card", "app.settings.section", "app.panel", "app.tab", "app.kanban.view", "app.settings.page", "app.composer.action"];
export type HostJourneyKind = (typeof HOST_JOURNEY_KINDS)[number];
/** Manifest `app.*` kinds vs Host catalog snake_case keys. */
export declare const MANIFEST_KIND_TO_CATALOG: Record<string, string>;
export declare function catalogKindFor(kind: string): string;
export declare function isChromeKind(kind: string): kind is ChromeKind;
/** Kinds the package itself declared — the Host journey asserts exactly these. */
export declare function chromeKindsFromIntegrations(integrations: unknown): ChromeKind[];
/** Chrome plus Batch 2 structure kinds the Host journey must see appear and vanish. */
export declare function hostJourneyKindsFromIntegrations(integrations: unknown): HostJourneyKind[];
export interface LiveContribution {
    pluginId?: string;
    kind?: string;
}
export declare function liveKindsForPlugin(items: readonly LiveContribution[], pluginId: string): string[];
export declare function catalogHasKinds(items: readonly LiveContribution[], pluginId: string, required: readonly string[]): boolean;
export declare function catalogLacksKinds(items: readonly LiveContribution[], pluginId: string, required: readonly string[]): boolean;
export {};
