import type { TFunction } from 'i18next';

import type { PluginControlItem } from '@/lib/api/plugins';

export const PLUGIN_DEVELOPMENT_PLUGIN_ID = 'vibex.plugin-development';
export const PLUGIN_DEVELOPMENT_DOCS_URL =
  'https://vibex.xforver.xin/docs/developers';

export const OFFICIAL_PLUGIN_I18N_KEY = {
  'vibex.browser': 'browser',
  'vibex.office': 'office',
  'vibex.workflow-creator': 'workflowCreator',
  'vibex.session-enhance': 'sessionEnhance',
  'vibex.plugin-development': 'pluginDevelopment',
  'vibex.host-chrome': 'hostChrome',
  'vibex.host-surface': 'hostSurface',
  'vibex.provider-import': 'providerImport',
  'vibex.provider-switch': 'providerSwitch',
  'vibex.remote-ssh': 'remoteSsh',
  'vibex.science': 'science',
  'vibex.open-connector': 'openConnector',
  'vibex-plugin-computer-use': 'computerUse',
  'vibex.computer-use': 'computerUse',
  'vibex.kanban-views': 'kanbanViews',
  'vibex.notes': 'notes',
  'vibex.prompt-enhancer': 'promptEnhancer',
} as const;

export type PluginCategoryKey =
  | 'design'
  | 'development'
  | 'science'
  | 'ai-enhancement'
  | 'utilities'
  | 'aigc'
  | 'other';

export const PLUGIN_CATEGORY_ORDER: readonly PluginCategoryKey[] = [
  'design',
  'development',
  'science',
  'ai-enhancement',
  'utilities',
  'aigc',
  'other',
] as const;

export const MARKETPLACE_CATEGORY_TAB_IDS: readonly (
  | 'all'
  | PluginCategoryKey
)[] = ['all', ...PLUGIN_CATEGORY_ORDER] as const;

const OFFICIAL_PLUGIN_CATEGORY_BY_KEY: Record<
  OfficialPluginI18nKey,
  PluginCategoryKey
> = {
  kanbanViews: 'design',
  hostChrome: 'design',
  hostSurface: 'design',
  pluginDevelopment: 'development',
  remoteSsh: 'development',
  openConnector: 'development',
  science: 'science',
  sessionEnhance: 'ai-enhancement',
  promptEnhancer: 'ai-enhancement',
  providerSwitch: 'ai-enhancement',
  providerImport: 'ai-enhancement',
  computerUse: 'ai-enhancement',
  browser: 'utilities',
  notes: 'utilities',
  office: 'aigc',
  workflowCreator: 'aigc',
};

const BARE_OFFICIAL_ID_TO_KEY: Record<string, OfficialPluginI18nKey> = {
  browser: 'browser',
  office: 'office',
  'workflow-creator': 'workflowCreator',
  'session-enhance': 'sessionEnhance',
  'plugin-development': 'pluginDevelopment',
  'host-chrome': 'hostChrome',
  'host-surface': 'hostSurface',
  'provider-import': 'providerImport',
  'provider-switch': 'providerSwitch',
  'remote-ssh': 'remoteSsh',
  science: 'science',
  'open-connector': 'openConnector',
  'computer-use': 'computerUse',
  'kanban-views': 'kanbanViews',
  notes: 'notes',
  'prompt-enhancer': 'promptEnhancer',
};

const CATEGORY_LABELS_ZH: Record<'all' | PluginCategoryKey, string> = {
  all: '全部',
  design: '设计',
  development: '开发',
  science: '科研',
  'ai-enhancement': 'AI增强',
  utilities: '实用工具',
  aigc: 'AIGC',
  other: '其他',
};

const CATEGORY_LABELS_EN: Record<'all' | PluginCategoryKey, string> = {
  all: 'All',
  design: 'Design',
  development: 'Development',
  science: 'Science',
  'ai-enhancement': 'AI Enhancement',
  utilities: 'Utilities',
  aigc: 'AIGC',
  other: 'Other',
};

export function pluginCategoryLabel(
  category: 'all' | PluginCategoryKey | string,
  t: TFunction<'settings'>,
  isZh?: boolean
): string {
  const normalized = category as 'all' | PluginCategoryKey;
  if (normalized in CATEGORY_LABELS_ZH) {
    if (typeof isZh === 'boolean') {
      return isZh
        ? CATEGORY_LABELS_ZH[normalized]
        : CATEGORY_LABELS_EN[normalized];
    }
    if (normalized === 'all') {
      return t('plugins.allCategory', { defaultValue: '全部' });
    }
    return t(`plugins.listingCategory.${normalized}`, {
      defaultValue: CATEGORY_LABELS_ZH[normalized],
    });
  }
  return t(`plugins.listingCategory.${category}`, { defaultValue: category });
}

export function normalizePluginCategory(
  rawCategory?: string | null
): PluginCategoryKey | null {
  const value = (rawCategory ?? '').trim().toLowerCase();
  if (!value || value === 'official' || value === 'community') return null;
  if (value === 'design' || value === 'ui' || value === '设计') return 'design';
  if (
    value === 'development' ||
    value === 'dev' ||
    value === 'devtools' ||
    value === 'mcp' ||
    value === '开发'
  ) {
    return 'development';
  }
  if (value === 'science' || value === 'research' || value === '科研') {
    return 'science';
  }
  if (
    value === 'ai-enhancement' ||
    value === 'ai' ||
    value === 'agent' ||
    value === 'ai增强'
  ) {
    return 'ai-enhancement';
  }
  if (
    value === 'utilities' ||
    value === 'utility' ||
    value === 'tools' ||
    value === 'productivity' ||
    value === '实用工具'
  ) {
    return 'utilities';
  }
  if (value === 'aigc' || value === 'workflow' || value === 'generation') {
    return 'aigc';
  }
  if (value === 'other' || value === '其他') {
    return 'other';
  }
  return null;
}

export function resolveOfficialPluginKey(
  id: string,
  publisherOrOwner?: string | null
): OfficialPluginI18nKey | null {
  const trimmed = id.trim();
  if (isOfficialPluginId(trimmed)) {
    return OFFICIAL_PLUGIN_I18N_KEY[trimmed];
  }
  const lowerOwner = (publisherOrOwner ?? '').trim().toLowerCase();
  if (!lowerOwner || lowerOwner === 'vibex') {
    const bare = BARE_OFFICIAL_ID_TO_KEY[trimmed.toLowerCase()];
    if (bare) return bare;
  }
  return null;
}

export function resolvePluginCategory(
  pluginId: string,
  options?: {
    publisher?: string | null;
    rawCategory?: string | null;
    builtin?: boolean;
  }
): PluginCategoryKey {
  const officialKey = resolveOfficialPluginKey(
    pluginId,
    options?.publisher ?? (options?.builtin ? 'vibex' : undefined)
  );
  if (officialKey) {
    return OFFICIAL_PLUGIN_CATEGORY_BY_KEY[officialKey];
  }
  return normalizePluginCategory(options?.rawCategory) ?? 'other';
}

export type OfficialPluginId = keyof typeof OFFICIAL_PLUGIN_I18N_KEY;
export type OfficialPluginI18nKey =
  (typeof OFFICIAL_PLUGIN_I18N_KEY)[OfficialPluginId];

export function isOfficialPluginId(id: string): id is OfficialPluginId {
  return Object.prototype.hasOwnProperty.call(OFFICIAL_PLUGIN_I18N_KEY, id);
}

export function officialPluginI18nKey(id: string) {
  return isOfficialPluginId(id) ? OFFICIAL_PLUGIN_I18N_KEY[id] : null;
}

export function officialPluginCopy(
  id: string,
  field: 'name' | 'summary' | 'readme',
  fallback: string,
  t: TFunction<'settings'>
) {
  const key = officialPluginI18nKey(id);
  return key
    ? t(`plugins.official.${key}.${field}`, { defaultValue: fallback })
    : fallback;
}

export function officialPluginName(
  id: string,
  fallback: string,
  t: TFunction<'settings'>
) {
  return officialPluginCopy(id, 'name', fallback, t);
}

export function officialListingName(
  listing: {
    pluginName: string;
    displayName: string;
    offlinePluginId?: string | null;
  },
  t: TFunction<'settings'>
) {
  return officialPluginName(
    listing.offlinePluginId ?? listing.pluginName,
    listing.displayName,
    t
  );
}

export function officialListingSummary(
  listing: {
    pluginName: string;
    summary: string;
    offlinePluginId?: string | null;
  },
  t: TFunction<'settings'>
) {
  return officialPluginSummary(
    listing.offlinePluginId ?? listing.pluginName,
    listing.summary,
    t
  );
}

export function officialPluginSummary(
  id: string,
  fallback: string | null,
  t: TFunction<'settings'>
) {
  return officialPluginCopy(
    id,
    'summary',
    fallback ?? t('plugins.noSummary'),
    t
  );
}

export function officialPluginReadme(
  id: string,
  fallback: string,
  t: TFunction<'settings'>
) {
  return officialPluginCopy(id, 'readme', fallback, t);
}

export function officialConfigFieldCopy(
  pluginId: string,
  field: string,
  schema: { title?: unknown; description?: unknown },
  t: TFunction<'settings'>
) {
  const key = officialPluginI18nKey(pluginId);
  const fallbackTitle =
    typeof schema.title === 'string' && schema.title ? schema.title : field;
  const fallbackDescription =
    typeof schema.description === 'string' ? schema.description : undefined;
  if (!key) {
    return {
      title: fallbackTitle,
      description: fallbackDescription,
      enumLabel: (value: string) => value,
    };
  }
  const base = `plugins.official.${key}.config.${field}`;
  const description = t(`${base}.description`, {
    defaultValue: fallbackDescription ?? '',
  });
  return {
    title: t(`${base}.title`, { defaultValue: fallbackTitle }),
    description: description || undefined,
    enumLabel: (value: string) =>
      t(`${base}.enum.${value}`, { defaultValue: value }),
  };
}

export type PluginInstallSource = 'builtin' | 'linked' | 'installed';

export function pluginInstallSource(
  plugin: Pick<PluginControlItem, 'builtin' | 'sourceKind'>
): PluginInstallSource {
  if (plugin.builtin || plugin.sourceKind === 'builtin') return 'builtin';
  if (plugin.sourceKind === 'developer_link') return 'linked';
  return 'installed';
}

export function pluginSourceLabel(
  source: PluginInstallSource,
  t: TFunction<'settings'>
) {
  if (source === 'builtin') return t('plugins.sourceBuiltin');
  if (source === 'linked') return t('plugins.sourceLinked');
  return t('plugins.sourceInstalled');
}

export function isOpenSourcePluginOrigin(source: {
  sourceKind?: string | null;
  repo?: string | null;
  homepage?: string | null;
  sourceOrigin?: string | null;
  showTree?: boolean | null;
  sourceShowTree?: boolean | null;
}) {
  if (typeof source.showTree === 'boolean') return source.showTree;
  if (typeof source.sourceShowTree === 'boolean') return source.sourceShowTree;
  const kind = (source.sourceKind ?? '').toLowerCase();
  if (kind === 'builtin' || kind === 'developer_link') {
    return false;
  }
  if (kind === 'github') return true;
  const origin = `${source.repo ?? ''}\n${source.sourceOrigin ?? ''}\n${source.homepage ?? ''}`;
  if (/github\.com|gitlab\.com|codeberg\.org|bitbucket\.org|\.git(?:$|[/?#])/i.test(origin)) {
    return true;
  }
  return false;
}

export function pluginCanUninstall(
  plugin: Pick<
    PluginControlItem,
    'builtin' | 'sourceKind' | 'uninstallSupported'
  >
) {
  if (plugin.uninstallSupported === false) return false;
  return true;
}
