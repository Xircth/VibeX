import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import type { CatalogListing } from '@/lib/api/plugins';
import {
  officialListingName,
  officialListingSummary,
} from './officialPlugins';
import {
  flattenMarketplaceListings,
  listingsInMarketplaceTab,
  listingTopicCategory,
  marketplaceCategoryTabIds,
} from './marketplaceListing';

const MODE_TABS = [
  ['installed', 'plugins.installedTab'],
  ['marketplace', 'plugins.marketplaceTab'],
] as const;

function moveTabIndex(
  event: { key: string; preventDefault: () => void },
  index: number,
  length: number
) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + length) % length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = length - 1;
  else return null;
  event.preventDefault();
  return next;
}

export function PluginCatalogModeTabs({
  value,
  onChange,
}: {
  value: 'installed' | 'marketplace';
  onChange: (value: 'installed' | 'marketplace') => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div
      className="chat-channel-tabs"
      role="tablist"
      aria-label={t('plugins.catalogModeAria')}
      onKeyDown={(event) => {
        const index = MODE_TABS.findIndex(([id]) => id === value);
        const next = moveTabIndex(event, index, MODE_TABS.length);
        if (next == null) return;
        const tab = MODE_TABS[next];
        onChange(tab[0]);
        event.currentTarget
          .querySelector<HTMLButtonElement>(`[data-plugin-mode="${tab[0]}"]`)
          ?.focus();
      }}
    >
      {MODE_TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-plugin-mode={id}
          aria-selected={value === id}
          className={value === id ? 'is-active' : undefined}
          onClick={() => onChange(id)}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

export function PluginMarketplaceList({
  official,
  community,
  loading,
  installingId,
  canInstall,
  onInstall,
}: {
  official: CatalogListing[];
  community: CatalogListing[];
  loading: boolean;
  installingId: string | null;
  canInstall: boolean;
  onInstall: (listing: CatalogListing) => void;
}) {
  const { t } = useTranslation('settings');
  const [category, setCategory] = useState('all');
  const listings = useMemo(
    () => flattenMarketplaceListings(official, community),
    [community, official]
  );
  const tabs = useMemo(() => marketplaceCategoryTabIds(listings), [listings]);
  const selected = tabs.includes(category) ? category : 'all';
  const visible = useMemo(
    () => listingsInMarketplaceTab(listings, selected),
    [listings, selected]
  );

  if (loading) {
    return (
      <div className="product-plugin-loading" role="status">
        <Loader2 aria-hidden="true" className="animate-spin" />
        <span>{t('plugins.marketplaceLoading')}</span>
      </div>
    );
  }

  return (
    <div className="product-plugin-market">
      <div
        className="product-plugin-underline-tabs"
        role="tablist"
        aria-label={t('plugins.marketplaceCategoriesAria')}
        onKeyDown={(event) => {
          const index = tabs.findIndex((id) => id === selected);
          const next = moveTabIndex(event, index, tabs.length);
          if (next == null) return;
          const tab = tabs[next];
          setCategory(tab);
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              `[data-plugin-category="${tab}"]`
            )
            ?.focus();
        }}
      >
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-plugin-category={id}
            aria-selected={selected === id}
            className={selected === id ? 'is-active' : undefined}
            onClick={() => setCategory(id)}
          >
            {id === 'all'
              ? t('plugins.allCategory')
              : id === 'official'
                ? t('plugins.officialCategory')
                : t(`plugins.listingCategory.${id}`, { defaultValue: id })}
          </button>
        ))}
      </div>
      <div className="product-plugin-market-list">
        {visible.length ? (
          visible.map((listing) => (
            <MarketplaceRow
              key={`${listing.owner}/${listing.pluginName}/${listing.tag}`}
              listing={listing}
              installing={
                installingId === `${listing.owner}/${listing.pluginName}`
              }
              canInstall={canInstall}
              onInstall={onInstall}
            />
          ))
        ) : (
          <div className="product-plugin-empty">
            <strong>{t('plugins.marketplaceEmpty')}</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function MarketplaceRow({
  listing,
  installing,
  canInstall,
  onInstall,
}: {
  listing: CatalogListing;
  installing: boolean;
  canInstall: boolean;
  onInstall: (listing: CatalogListing) => void;
}) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  return (
    <div className="product-plugin-row">
      <button
        type="button"
        className="product-plugin-open"
        onClick={() =>
          navigate(
            `/plugins/marketplace/${encodeURIComponent(listing.owner)}/${encodeURIComponent(listing.pluginName)}`
          )
        }
      >
        <span className="product-plugin-row-copy">
          <span className="product-plugin-row-title">
            <strong>{officialListingName(listing, t)}</strong>
            <span className="product-plugin-row-tags">
              <span>{listing.owner}</span>
              {listingTopicCategory(listing.category) ? (
                <span>
                  {t(`plugins.listingCategory.${listing.category}`, {
                    defaultValue: listing.category,
                  })}
                </span>
              ) : null}
              <span>v{listing.version}</span>
            </span>
          </span>
          <span className="product-plugin-row-summary">
            {officialListingSummary(listing, t)}
          </span>
        </span>
      </button>
      {canInstall ? (
        <span className="product-plugin-row-actions">
          <Button
            type="button"
            size="sm"
            disabled={installing}
            onClick={(event) => {
              event.stopPropagation();
              onInstall(listing);
            }}
          >
            {installing ? t('plugins.installingPlugin') : t('plugins.install')}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
