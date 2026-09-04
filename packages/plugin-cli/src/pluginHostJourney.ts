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

const CHROME_KIND_SET = new Set<string>(CHROME_KINDS);

export function isChromeKind(kind: string): kind is ChromeKind {
  return CHROME_KIND_SET.has(kind);
}

/** Kinds the package itself declared — the Host journey asserts exactly these. */
export function chromeKindsFromIntegrations(integrations: unknown): ChromeKind[] {
  if (!Array.isArray(integrations)) return [];
  const seen = new Set<ChromeKind>();
  for (const item of integrations) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind === "string" && isChromeKind(kind)) {
      seen.add(kind);
    }
  }
  return CHROME_KINDS.filter((kind) => seen.has(kind));
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
  return required.every((kind) => live.has(kind));
}

export function catalogLacksKinds(
  items: readonly LiveContribution[],
  pluginId: string,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const live = new Set(liveKindsForPlugin(items, pluginId));
  return required.every((kind) => !live.has(kind));
}
