import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { CatalogListing } from '@/lib/api/plugins';
import { officialListingName } from './officialPlugins';

export function listingSourceLabel(
  listing: CatalogListing,
  t: TFunction<'settings'>
) {
  const kind = (listing.sourceKind ?? '').toLowerCase();
  if (kind === 'official' || kind === 'offline') {
    return t('plugins.installPreviewSourceOfficial');
  }
  if (kind === 'snapshot' || kind === 'archive' || kind === 'upload') {
    return t('plugins.installPreviewSourceLocal');
  }
  const origin = `${listing.repo ?? ''}\n${listing.homepage ?? ''}`;
  const github = origin.match(/github\.com\/([^/\s]+\/[^/\s]+)/i);
  if (kind === 'github' || github) {
    return github
      ? `GitHub ${github[1].replace(/\.git$/, '')}`
      : t('plugins.installPreviewSourceGithub');
  }
  const raw = listing.homepage || listing.downloadUrl || '';
  if (/marketplace|xforever\.xin/i.test(raw)) {
    return t('plugins.installPreviewSourceOfficial');
  }
  if (
    raw.startsWith('/') ||
    raw.startsWith('file:') ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    return t('plugins.installPreviewSourceLocal');
  }
  try {
    return new URL(raw).host;
  } catch {
    return raw || t('plugins.installPreviewSourceLocal');
  }
}

export function PluginInstallTrustDialog({
  listing,
  onCancel,
  onConfirm,
}: {
  listing: CatalogListing | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const name = listing ? officialListingName(listing, t) : '';
  const source = listing ? listingSourceLabel(listing, t) : '';

  return (
    <Dialog
      open={Boolean(listing)}
      className="product-plugin-trust-dialog !max-w-[22rem]"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('plugins.installPreviewTitle')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('plugins.fullTrustConfirm')}
          </DialogDescription>
        </DialogHeader>
        {listing ? (
          <div className="product-plugin-trust">
            <div className="product-plugin-trust-identity">
              <p className="product-plugin-trust-name">{name}</p>
              <dl className="product-plugin-trust-source">
                <div>
                  <dt>{t('plugins.installPreviewSourceLabel')}</dt>
                  <dd>{source}</dd>
                </div>
              </dl>
            </div>
            <div className="product-plugin-trust-callout" role="note">
              <ShieldAlert aria-hidden="true" />
              <div>
                <strong>{t('plugins.installPreviewPermissionLabel')}</strong>
                <p>{t('plugins.fullTrustConfirm')}</p>
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t('plugins.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
