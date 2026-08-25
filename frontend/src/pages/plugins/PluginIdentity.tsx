import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import type { PluginControlItem } from '@/lib/api/plugins';

import { pluginInstallSource, pluginSourceLabel } from './officialPlugins';

export function PluginIdentityMeta({
  plugin,
}: {
  plugin: Pick<
    PluginControlItem,
    | 'builtin'
    | 'sourceKind'
    | 'version'
    | 'sourceLocked'
    | 'sourceRef'
    | 'packageDigest'
  >;
}) {
  const { t } = useTranslation('settings');
  const source = pluginInstallSource(plugin);
  const digest = plugin.packageDigest
    ? plugin.packageDigest.slice(0, 8)
    : null;

  return (
    <div
      className="product-plugin-identity-meta"
      role="group"
      aria-label={t('plugins.productMetadata')}
    >
      <Badge
        variant={source === 'builtin' ? 'secondary' : 'outline'}
        className="product-plugin-source-badge"
        title={t('plugins.sourceTitle')}
      >
        {pluginSourceLabel(source, t)}
      </Badge>
      <Badge
        variant="outline"
        className="product-plugin-version-badge"
        title={t('plugins.versionTitle')}
      >
        v{plugin.version}
      </Badge>
      {plugin.sourceLocked ? (
        <Badge
          variant="outline"
          className="product-plugin-lock-badge"
          title={plugin.sourceRef ?? t('plugins.sourceLocked')}
        >
          {plugin.sourceRef
            ? t('plugins.lockedTo', { ref: plugin.sourceRef })
            : t('plugins.sourceLocked')}
        </Badge>
      ) : null}
      {digest ? (
        <Badge
          variant="outline"
          className="product-plugin-digest-badge"
          title={plugin.packageDigest ?? digest}
        >
          {digest}
        </Badge>
      ) : null}
    </div>
  );
}
