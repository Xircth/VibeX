import i18n from '@/i18n';
import enPanels from '@/i18n/locales/en/panels.json';
import zhPanels from '@/i18n/locales/zh-CN/panels.json';
import { BUILTIN_PANEL_MANIFESTS } from '@/features/plugins/builtin-contributions';

/**
 * Builtin Dockview panel id -> title key in the `panels` namespace, taken from
 * the panel manifests. Dockview persists the tab title string in the saved
 * layout, so tabs restored from an earlier session would otherwise keep
 * whatever language they were created in. Tabs resolve their title through here
 * at render time instead.
 */
const BUILTIN_PANEL_TITLE_KEYS: Record<string, string> = Object.fromEntries(
  BUILTIN_PANEL_MANIFESTS.map((manifest) => [manifest.id, manifest.titleKey])
);

const PANEL_REGISTRY_PREFIX = 'panelRegistry.';

/** Hardcoded English titles the panels were created with before i18n. */
const LEGACY_TITLES: Record<string, string[]> = {
  'session-details': ['Session Details'],
  'session-list': ['Session List'],
  'file-tree': ['File Explorer'],
};

type PanelRegistryStrings = Record<string, string>;
const LOCALE_TABLES: PanelRegistryStrings[] = [
  (enPanels as { panelRegistry: PanelRegistryStrings }).panelRegistry,
  (zhPanels as { panelRegistry: PanelRegistryStrings }).panelRegistry,
];

type Translate = (key: string, options?: Record<string, unknown>) => string;

function panelRegistryKey(panelId: string): string | undefined {
  const titleKey = BUILTIN_PANEL_TITLE_KEYS[panelId];
  if (!titleKey?.startsWith(PANEL_REGISTRY_PREFIX)) return undefined;
  return titleKey.slice(PANEL_REGISTRY_PREFIX.length);
}

function isDefaultTitle(panelId: string, key: string, title: string): boolean {
  if (!title) return true;
  if (LEGACY_TITLES[panelId]?.includes(title)) return true;
  return LOCALE_TABLES.some((table) => table[key] === title);
}

/**
 * Localized title for a builtin panel. Only replaces titles that are a known
 * default (in any locale), so custom or dynamic titles pass through.
 */
export function resolveBuiltinPanelTitle(
  panelId: string,
  storedTitle: string,
  t: Translate = i18n.t.bind(i18n) as Translate
): string {
  const key = panelRegistryKey(panelId);
  if (!key || !isDefaultTitle(panelId, key, storedTitle)) return storedTitle;
  return t(`panels:${PANEL_REGISTRY_PREFIX}${key}`);
}

/** Current-language title for a builtin panel id (for addPanel calls). */
export function builtinPanelTitle(panelId: string): string {
  const titleKey = BUILTIN_PANEL_TITLE_KEYS[panelId];
  return titleKey ? i18n.t(`panels:${titleKey}`) : panelId;
}
