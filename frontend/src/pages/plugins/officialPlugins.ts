import type { TFunction } from 'i18next';

import type { PluginControlItem } from '@/lib/api/plugins';

export const PLUGIN_DEVELOPMENT_PLUGIN_ID = 'vibex.plugin-development';
export const PLUGIN_DEVELOPMENT_DOCS_URL =
  'https://vibex.xforver.xin/docs/developers';

export const OFFICIAL_PLUGIN_I18N_KEY = {
  'vibex.office': 'office',
  'vibex.workflow-creator': 'workflowCreator',
  'vibex.session-enhance': 'sessionEnhance',
  'vibex.multi-agent': 'multiAgent',
  'vibex.plugin-development': 'pluginDevelopment',
} as const;

export type OfficialPluginId = keyof typeof OFFICIAL_PLUGIN_I18N_KEY;

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
  sourceOrigin?: string | null;
}) {
  const kind = (source.sourceKind ?? '').toLowerCase();
  if (
    kind === 'snapshot' ||
    kind === 'archive' ||
    kind === 'upload' ||
    kind === 'offline' ||
    kind === 'builtin' ||
    kind === 'developer_link'
  ) {
    return false;
  }
  if (kind === 'github') return true;
  const origin = `${source.repo ?? ''}\n${source.sourceOrigin ?? ''}`;
  return /github\.com|gitlab\.com|codeberg\.org|bitbucket\.org/i.test(origin);
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
