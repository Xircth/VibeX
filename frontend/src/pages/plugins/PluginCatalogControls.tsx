import {
  Loader2,
  PackageOpen,
  PackagePlus,
  TerminalSquare,
} from 'lucide-react';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { PluginDevConnection } from '@/lib/api/plugins';
import { PLUGIN_DEVELOPMENT_DOCS_URL } from './officialPlugins';

export function PluginCatalogActions({
  canDevelop,
  canAdd,
  adding,
  search,
  onOpenDevelopment,
  onAdd,
}: {
  canDevelop: boolean;
  canAdd: boolean;
  adding: boolean;
  search?: ReactNode;
  onOpenDevelopment: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="product-plugins-header-actions">
      {search}
      {canDevelop ? (
        <Button type="button" variant="outline" onClick={onOpenDevelopment}>
          <TerminalSquare aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.developerTools')}
        </Button>
      ) : null}
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
      className="product-plugin-detail-loading settings-surface"
      role="status"
      aria-label={t('plugins.loadingPluginDetail')}
    >
      <div className="product-plugin-detail-loading-tree">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton
            className="h-3"
            style={{ width: `${68 + (row % 3) * 9}%` }}
            key={row}
          />
        ))}
      </div>
      <div className="product-plugin-detail-loading-document">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

export function PluginDevelopmentDialog({
  open,
  connection,
  onOpenChange,
  onOpenPlugin,
}: {
  open: boolean;
  connection: PluginDevConnection | null;
  onOpenChange: (open: boolean) => void;
  onOpenPlugin: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <Dialog
      className="product-plugin-dev-dialog max-w-md"
      open={open}
      onOpenChange={onOpenChange}
      aria-label={t('plugins.developerTools')}
    >
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle>{t('plugins.developerTools')}</DialogTitle>
          <DialogDescription>
            {t('plugins.devHostDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="product-plugin-dev-connection">
          <div className="product-plugin-dev-status-row">
            <span
              className="product-plugin-dev-status"
              data-ready={connection ? 'true' : 'false'}
            >
              <i aria-hidden="true" />
              {connection
                ? t('plugins.devHostReady')
                : t('plugins.devHostUnavailable')}
            </span>
            <a
              className="product-plugin-dev-docs"
              href={PLUGIN_DEVELOPMENT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t('plugins.pluginDevDocs')}
            </a>
          </div>
          {connection ? <code>{connection.endpoint}</code> : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('common:close')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onOpenPlugin();
            }}
          >
            {t('plugins.enablePluginDevelopment')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
