import i18n from '@/i18n';
import enPanels from '@/i18n/locales/en/panels.json';
import zhPanels from '@/i18n/locales/zh-CN/panels.json';

/**
 * Builtin Dockview panel id -> panels:panelRegistry key. Dockview persists the
 * tab title string in the saved layout, so tabs restored from an earlier
 * session would otherwise keep whatever language they were created in. Tabs
 * resolve their title through here at render time instead.
 */
const BUILTIN_PANEL_TITLE_KEYS: Record<string, string> = {
  kanban: 'kanban',
  'file-tree': 'fileExplorer',
  preview: 'preview',
  diffs: 'diffs',
  terminal: 'terminal',
  'ai-chat': 'aiChat',
  git: 'git',
  merge: 'merge',
  welcome: 'welcome',
  logs: 'logs',
  notes: 'notes',
  'session-details': 'sessionDetails',
  processes: 'processes',
  search: 'search',
  'session-list': 'sessionList',
};

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
  const key = BUILTIN_PANEL_TITLE_KEYS[panelId];
  if (!key || !isDefaultTitle(panelId, key, storedTitle)) return storedTitle;
  return t(`panels:panelRegistry.${key}`);
}

/** Current-language title for a builtin panel id (for addPanel calls). */
export function builtinPanelTitle(panelId: string): string {
  const key = BUILTIN_PANEL_TITLE_KEYS[panelId];
  return key ? i18n.t(`panels:panelRegistry.${key}`) : panelId;
}
