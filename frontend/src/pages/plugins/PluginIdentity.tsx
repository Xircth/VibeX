import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import type { PluginControlItem } from '@/lib/api/plugins';

import { pluginInstallSource, pluginSourceLabel } from './officialPlugins';

export function PluginIdentityMeta({
  plugin,
}: {
  plugin: Pick<PluginControlItem, 'builtin' | 'sourceKind' | 'version'>;
}) {
  const { t } = useTranslation('settings');
  const source = pluginInstallSource(plugin);

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
    </div>
  );
}
