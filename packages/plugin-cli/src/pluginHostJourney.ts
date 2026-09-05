/** Chrome slots that Batch 1 put on the stable surface. */
export const CHROME_KINDS = [
  "app.command",
  "app.toolbar",
  "app.status",
  "app.composer.slash",
  "app.timeline.card",
  "app.settings.section",
] as const;

export type ChromeKind = (typeof CHROME_KINDS)[number];

/** Structure surfaces Batch 2 added. settings.page is preview, not a stable surface. */
export const STRUCTURE_KINDS = [
  "app.panel",
  "app.tab",
  "app.kanban.view",
  "app.settings.page",
  "app.composer.action",
] as const;

export type StructureKind = (typeof STRUCTURE_KINDS)[number];

const HOST_JOURNEY_KINDS = [...CHROME_KINDS, ...STRUCTURE_KINDS] as const;

export type HostJourneyKind = (typeof HOST_JOURNEY_KINDS)[number];

const CHROME_KIND_SET = new Set<string>(CHROME_KINDS);

/** Manifest `app.*` kinds vs Host catalog snake_case keys. */
export const MANIFEST_KIND_TO_CATALOG: Record<string, string> = {
  "app.command": "command",
  "app.toolbar": "toolbar",
  "app.status": "status",
  "app.composer.slash": "composer_slash",
  "app.timeline.card": "timeline_card",
  "app.settings.section": "settings_section",
  "app.panel": "app_panel",
  "app.tab": "app_tab",
  "app.kanban.view": "kanban_view",
  "app.settings.page": "settings_page",
  "app.composer.action": "composer_action",
  "provider.remote.provisioner": "remote_provisioner",
};

export function catalogKindFor(kind: string): string {
  return MANIFEST_KIND_TO_CATALOG[kind] ?? kind;
}

export function isChromeKind(kind: string): kind is ChromeKind {
  return CHROME_KIND_SET.has(kind);
}

function kindsFromIntegrations<T extends string>(
  integrations: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(integrations)) return [];
  const seen = new Set<T>();
  const allowedSet = new Set<string>(allowed);
  for (const item of integrations) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind === "string" && allowedSet.has(kind)) {
      seen.add(kind as T);
    }
  }
  return allowed.filter((kind) => seen.has(kind));
}

/** Kinds the package itself declared — the Host journey asserts exactly these. */
export function chromeKindsFromIntegrations(integrations: unknown): ChromeKind[] {
  return kindsFromIntegrations(integrations, CHROME_KINDS);
}

/** Chrome plus Batch 2 structure kinds the Host journey must see appear and vanish. */
export function hostJourneyKindsFromIntegrations(
  integrations: unknown,
): HostJourneyKind[] {
  return kindsFromIntegrations(integrations, HOST_JOURNEY_KINDS);
}

export interface LiveContribution {
  pluginId?: string;
  kind?: string;
}

export function liveKindsForPlugin(
  items: readonly LiveContribution[],
  pluginId: string,
): string[] {
  return items
    .filter((item) => item.pluginId === pluginId && typeof item.kind === "string")
    .map((item) => item.kind as string);
}

export function catalogHasKinds(
  items: readonly LiveContribution[],
  pluginId: string,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const live = new Set(liveKindsForPlugin(items, pluginId));
  return required.every(
    (kind) => live.has(catalogKindFor(kind)) || live.has(kind),
  );
}

export function catalogLacksKinds(
  items: readonly LiveContribution[],
  pluginId: string,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const live = new Set(liveKindsForPlugin(items, pluginId));
  return required.every(
    (kind) => !live.has(catalogKindFor(kind)) && !live.has(kind),
  );
}
