import type {
  PluginControlItem,
  PluginRuntimeInventoryItem,
} from '@/lib/api/plugins';

export const FORMAT_LABELS: Record<string, string> = {
  vibex: 'VibeX',
  codex: 'Codex',
  claude_code: 'Claude Code',
};

export type PluginEcosystem = 'codex' | 'claude_code' | 'vibex';

export const PLUGIN_TABS: Array<{ id: PluginEcosystem; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'vibex', label: 'VibeX' },
];

export const PLUGIN_LIST_PANE_STORAGE_KEY = 'vibex.pluginHub.listPanePercent';
export const PLUGIN_LIST_PANE_DEFAULT = 31;
export const PLUGIN_LIST_PANE_MIN = 22;
export const PLUGIN_LIST_PANE_MAX = 52;

export function clampPluginListPane(value: number) {
  return Math.min(PLUGIN_LIST_PANE_MAX, Math.max(PLUGIN_LIST_PANE_MIN, value));
}

export function initialPluginListPanePercent() {
  if (typeof window === 'undefined') return PLUGIN_LIST_PANE_DEFAULT;
  try {
    const stored = Number(
      window.localStorage.getItem(PLUGIN_LIST_PANE_STORAGE_KEY)
    );
    return Number.isFinite(stored) && stored > 0
      ? clampPluginListPane(stored)
      : PLUGIN_LIST_PANE_DEFAULT;
  } catch {
    return PLUGIN_LIST_PANE_DEFAULT;
  }
}

export function pluginEcosystem(plugin: PluginControlItem): PluginEcosystem {
  if (plugin.sourceKind === 'codex_native') return 'codex';
  if (plugin.sourceKind === 'claude_code_native') return 'claude_code';
  return 'vibex';
}

export function runtimeLockIsReady(
  contribution: PluginControlItem['runtimes'][number],
  installed: PluginRuntimeInventoryItem
) {
  return Boolean(
    contribution.target &&
      contribution.contentDigest &&
      installed.id === contribution.id &&
      installed.version === contribution.version &&
      installed.target === contribution.target &&
      installed.contentDigest === contribution.contentDigest
  );
}

export type PluginDetailMode = 'overview' | 'skills' | 'mcp';

export function contributionMetadata(item: { metadata: unknown }) {
  return item.metadata && typeof item.metadata === 'object'
    ? (item.metadata as Record<string, unknown>)
    : {};
}

export function fileExtensions(items: Array<{ metadata: unknown }>) {
  return [
    ...new Set(
      items.flatMap((item) => {
        const extensions = contributionMetadata(item).extensions;
        return Array.isArray(extensions)
          ? extensions.filter(
              (extension): extension is string => typeof extension === 'string'
            )
          : [];
      })
    ),
  ];
}
