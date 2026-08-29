import { Loader2, PackageOpen, PackagePlus } from 'lucide-react';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function PluginCatalogActions({
  canAdd,
  adding,
  search,
  onAdd,
}: {
  canAdd: boolean;
  adding: boolean;
  search?: ReactNode;
  onAdd: () => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="product-plugins-header-actions">
      {search}
      {canAdd ? (
        <Button type="button" disabled={adding} onClick={onAdd}>
          {adding ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('plugins.addPlugin')}
        </Button>
      ) : null}
    </div>
  );
}

export function PluginDropOverlay({
  active,
  installing,
}: {
  active: boolean;
  installing: boolean;
}) {
  const { t } = useTranslation('settings');
  if (!active && !installing) return null;

  const label = t(
    installing ? 'plugins.installingPlugin' : 'plugins.dropToInstall'
  );

  return (
    <div
      className="product-plugin-drop-overlay"
      role="status"
      aria-label={label}
    >
      {installing ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <PackageOpen aria-hidden="true" />
      )}
      <strong>{label}</strong>
    </div>
  );
}

export function PluginCatalogLoading() {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-loading"
      role="status"
      aria-label={t('plugins.loadingPlugins')}
    >
      {[0, 1, 2].map((row) => (
        <div className="product-plugin-loading-row" key={row}>
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <span className="product-plugin-loading-copy">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-3/5" />
          </span>
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function PluginDetailLoading() {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-detail-loading"
      role="status"
      aria-label={t('plugins.loadingPluginDetail')}
    >
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}
