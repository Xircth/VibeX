import {
  Check,
  Copy,
  Loader2,
  PackageOpen,
  PackagePlus,
  TerminalSquare,
} from 'lucide-react';
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

export function PluginCatalogActions({
  canDevelop,
  canAdd,
  adding,
  devReady,
  onOpenDevelopment,
  onAdd,
  onBrowseMarketplace,
}: {
  canDevelop: boolean;
  canAdd: boolean;
  adding: boolean;
  devReady: boolean;
  onOpenDevelopment: () => void;
  onAdd: () => void;
  onBrowseMarketplace?: () => void;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="product-plugins-header-actions">
      {canDevelop ? (
        <Button
          type="button"
          variant="outline"
          disabled={!devReady}
          onClick={onOpenDevelopment}
        >
          <TerminalSquare aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.developerTools')}
        </Button>
      ) : null}
      {canAdd && onBrowseMarketplace ? (
        <Button
          type="button"
          variant="outline"
          disabled={adding}
          onClick={onBrowseMarketplace}
        >
          {t('plugins.marketplace')}
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
  copied,
  onOpenChange,
  onCopy,
}: {
  open: boolean;
  connection: PluginDevConnection | null;
  copied: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
}) {
  const { t } = useTranslation('settings');

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
          <span className="product-plugin-dev-status">
            <i aria-hidden="true" />
            {t('plugins.devHostReady')}
          </span>
          <code>{connection?.endpoint}</code>
          <p>{t('plugins.devHostUsage')}</p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('common:close')}
          </Button>
          <Button type="button" disabled={!connection} onClick={onCopy}>
            {copied ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {copied
              ? t('plugins.devConnectionCopied')
              : t('plugins.copyDevConnection')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
