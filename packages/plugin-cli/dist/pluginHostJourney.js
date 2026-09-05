/** Chrome slots that Batch 1 put on the stable surface. */
export const CHROME_KINDS = [
    "app.command",
    "app.toolbar",
    "app.status",
    "app.composer.slash",
    "app.timeline.card",
    "app.settings.section",
];
/** Structure surfaces Batch 2 added. settings.page is preview, not a stable surface. */
export const STRUCTURE_KINDS = [
    "app.panel",
    "app.tab",
    "app.kanban.view",
    "app.settings.page",
    "app.composer.action",
];
const HOST_JOURNEY_KINDS = [...CHROME_KINDS, ...STRUCTURE_KINDS];
const CHROME_KIND_SET = new Set(CHROME_KINDS);
/** Manifest `app.*` kinds vs Host catalog snake_case keys. */
export const MANIFEST_KIND_TO_CATALOG = {
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
export function catalogKindFor(kind) {
    return MANIFEST_KIND_TO_CATALOG[kind] ?? kind;
}
export function isChromeKind(kind) {
    return CHROME_KIND_SET.has(kind);
}
function kindsFromIntegrations(integrations, allowed) {
    if (!Array.isArray(integrations))
        return [];
    const seen = new Set();
    const allowedSet = new Set(allowed);
    for (const item of integrations) {
        if (!item || typeof item !== "object")
            continue;
        const kind = item.kind;
        if (typeof kind === "string" && allowedSet.has(kind)) {
            seen.add(kind);
        }
    }
    return allowed.filter((kind) => seen.has(kind));
}
/** Kinds the package itself declared — the Host journey asserts exactly these. */
export function chromeKindsFromIntegrations(integrations) {
    return kindsFromIntegrations(integrations, CHROME_KINDS);
}
/** Chrome plus Batch 2 structure kinds the Host journey must see appear and vanish. */
export function hostJourneyKindsFromIntegrations(integrations) {
    return kindsFromIntegrations(integrations, HOST_JOURNEY_KINDS);
}
export function liveKindsForPlugin(items, pluginId) {
    return items
        .filter((item) => item.pluginId === pluginId && typeof item.kind === "string")
        .map((item) => item.kind);
}
export function catalogHasKinds(items, pluginId, required) {
    if (required.length === 0)
        return true;
    const live = new Set(liveKindsForPlugin(items, pluginId));
    return required.every((kind) => live.has(catalogKindFor(kind)) || live.has(kind));
}
export function catalogLacksKinds(items, pluginId, required) {
    if (required.length === 0)
        return true;
    const live = new Set(liveKindsForPlugin(items, pluginId));
    return required.every((kind) => !live.has(catalogKindFor(kind)) && !live.has(kind));
}
