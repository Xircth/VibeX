import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  PackageCheck,
  Sparkles,
  Store,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { CatalogListing } from '@/lib/api/plugins';
import { PluginMarketplaceLogo } from './OfficialPluginIcon';
import {
  PluginCategoryBadge,
  PluginDeveloperBadge,
  PluginInstallsBadge,
  PluginRowMetaColumns,
  PluginVersionBadge,
} from './PluginAttributeBadges';
import {
  FEATURED_OFFICIAL_PRIORITY_IDS,
  officialListingName,
  officialListingSummary,
  pluginCategoryLabel,
} from './officialPlugins';
import {
  flattenMarketplaceListings,
  listingMatchesPlugin,
  listingMatchesSearch,
  listingsInMarketplaceTab,
  marketplaceCategoryTabIds,
  resolveMarketplaceListingCategory,
  type InstalledPluginIdentity,
} from './marketplaceListing';

export type PluginCatalogMode = 'installed' | 'marketplace' | 'core';

const MARKETPLACE_SKELETON_CARDS = [
  { title: 'w-28', tag: 'w-12', summary: 'w-full' },
  { title: 'w-24', tag: 'w-10', summary: 'w-4/5' },
  { title: 'w-32', tag: 'w-14', summary: 'w-11/12' },
  { title: 'w-20', tag: 'w-11', summary: 'w-3/4' },
  { title: 'w-36', tag: 'w-9', summary: 'w-5/6' },
  { title: 'w-24', tag: 'w-12', summary: 'w-full' },
] as const;

function moveTabIndex(
  event: KeyboardEvent<HTMLElement>,
  index: number,
  length: number
) {
  if (length <= 0) return null;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    return (index + 1) % length;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    return (index - 1 + length) % length;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    return 0;
  }
  if (event.key === 'End') {
    event.preventDefault();
    return length - 1;
  }
  return null;
}

export function PluginCatalogModeTabs({
  value,
  onChange,
}: {
  value: PluginCatalogMode;
  onChange: (value: PluginCatalogMode) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <SegmentedControl
      className="dsh-plugin-mode-segmented shrink-0"
      value={value}
      onChange={(nextValue) => onChange(nextValue as PluginCatalogMode)}
      label={t('plugins.catalogModeAria')}
      size="sm"
      layout="hug"
    >
      <SegmentedControlItem
        value="installed"
        data-plugin-mode="installed"
        label={t('plugins.installedTab')}
        icon={<PackageCheck aria-hidden="true" />}
      />
      <SegmentedControlItem
        value="marketplace"
        data-plugin-mode="marketplace"
        label={t('plugins.marketplaceTab')}
        icon={<Store aria-hidden="true" />}
      />
      <SegmentedControlItem
        value="core"
        data-plugin-mode="core"
        label={t('plugins.coreModulesTab')}
        icon={<Cpu aria-hidden="true" />}
      />
    </SegmentedControl>
  );
}

export function PluginMarketplaceList({
  official,
  community,
  plugins,
  query,
  loading,
  installingId,
  canInstall,
  onInstall,
}: {
  official: CatalogListing[];
  community: CatalogListing[];
  plugins: InstalledPluginIdentity[];
  query: string;
  loading: boolean;
  installingId: string | null;
  canInstall: boolean;
  onInstall: (listing: CatalogListing) => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const [category, setCategory] = useState('all');
  const listings = useMemo(
    () => flattenMarketplaceListings(official, community),
    [community, official]
  );
  const matches = useMemo(
    () =>
      listings.filter((listing) =>
        listingMatchesSearch(
          listing,
          query,
          officialListingName(listing, t),
          officialListingSummary(listing, t)
        )
      ),
    [listings, query, t]
  );
  const tabs = useMemo(() => marketplaceCategoryTabIds(listings), [listings]);
  useEffect(() => {
    if (query.trim()) setCategory('all');
  }, [query]);
  const selected = tabs.includes(category as (typeof tabs)[number])
    ? category
    : 'all';
  const visible = useMemo(
    () => listingsInMarketplaceTab(matches, selected),
    [matches, selected]
  );

  const featuredListings = useMemo(() => {
    if (listings.length === 0) return [];
    const prioritized: CatalogListing[] = [];
    const usedKeys = new Set<string>();
    for (const targetId of FEATURED_OFFICIAL_PRIORITY_IDS) {
      const found = listings.find(
        (item) =>
          item.offlinePluginId === targetId || item.pluginName === targetId
      );
      if (found) {
        const key = `${found.owner}/${found.pluginName}`;
        if (!usedKeys.has(key)) {
          usedKeys.add(key);
          prioritized.push(found);
        }
      }
    }
    for (const item of listings) {
      if (prioritized.length >= 5) break;
      const key = `${item.owner}/${item.pluginName}`;
      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        prioritized.push(item);
      }
    }
    return prioritized.slice(0, 5);
  }, [listings]);

  if (loading) {
    return <PluginMarketplaceLoading label={t('plugins.marketplaceLoading')} />;
  }

  return (
    <div className="product-plugin-market dsh-market-container">
      {!query.trim() && featuredListings.length > 0 ? (
        <PluginMarketplaceCarousel listings={featuredListings} isZh={isZh} />
      ) : null}

      <div
        className="product-plugin-underline-tabs dsh-scale-tabs"
        role="tablist"
        aria-label={t('plugins.marketplaceCategoriesAria')}
        onKeyDown={(event) => {
          const index = tabs.findIndex((id) => id === selected);
          const next = moveTabIndex(event, index, tabs.length);
          if (next == null) return;
          const tab = tabs[next];
          setCategory(tab);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-plugin-category="${tab}"]`)
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
            <span className="dsh-scale-tab-tick" aria-hidden="true" />
            <span className="dsh-scale-tab-label">
              {pluginCategoryLabel(id, t, isZh)}
            </span>
          </button>
        ))}
      </div>

      <div className="product-plugin-market-list">
        {visible.length ? (
          <div className="product-plugin-market-grid dsh-market-rows">
            {visible.map((listing) => (
              <MarketplaceRow
                key={`${listing.owner}/${listing.pluginName}/${listing.tag}`}
                listing={listing}
                installing={
                  installingId === `${listing.owner}/${listing.pluginName}`
                }
                installed={plugins.some((plugin) =>
                  listingMatchesPlugin(listing, plugin)
                )}
                canInstall={canInstall}
                onInstall={onInstall}
              />
            ))}
          </div>
        ) : (
          <div className="product-plugin-empty">
            <strong>{t('plugins.marketplaceEmpty')}</strong>
            {query.trim() ? (
              <span className="product-plugin-muted">
                {t('plugins.productEmptySearchHint')}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function PluginMarketplaceCarousel({
  listings,
  isZh,
}: {
  listings: CatalogListing[];
  isZh: boolean;
}) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const safeIndex = listings.length > 0 ? activeIndex % listings.length : 0;
  const activeListing = listings[safeIndex];

  useEffect(() => {
    if (paused || listings.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % listings.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [listings.length, paused]);

  if (!activeListing) return null;

  const activePluginId =
    activeListing.offlinePluginId ?? activeListing.pluginName;
  const displayName = officialListingName(activeListing, t);
  const summary = officialListingSummary(activeListing, t);
  const resolvedCategory = resolveMarketplaceListingCategory(activeListing);
  const categoryName = pluginCategoryLabel(resolvedCategory, t, isZh);

  return (
    <section
      className="dsh-market-carousel"
      aria-label={isZh ? '推荐插件轮播' : 'Featured plugins'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="dsh-carousel-slide">
        <div className="dsh-carousel-main">
          <div className="dsh-carousel-badges">
            <span className="dsh-carousel-kicker">
              <Sparkles aria-hidden="true" />
              {isZh ? '推荐插件' : 'Featured Plugin'}
            </span>
            <PluginDeveloperBadge
              pluginId={activePluginId}
              owner={activeListing.owner}
              homepage={activeListing.homepage}
              repo={activeListing.repo}
              variant="badge"
            />
            <PluginCategoryBadge
              category={resolvedCategory}
              label={categoryName}
              variant="badge"
            />
            <PluginVersionBadge
              version={activeListing.version}
              tag={activeListing.tag}
              variant="badge"
            />
            <PluginInstallsBadge
              pluginId={activePluginId}
              owner={activeListing.owner}
              homepage={activeListing.homepage}
              repo={activeListing.repo}
              variant="badge"
            />
          </div>
          <div className="dsh-carousel-identity">
            <PluginMarketplaceLogo
              listing={activeListing}
              displayName={displayName}
            />
            <div className="dsh-carousel-copy">
              <h3 className="dsh-carousel-title">{`${displayName}\u200B`}</h3>
              <p className="dsh-carousel-summary">{`${summary}\u200B`}</p>
            </div>
          </div>
        </div>
        <div className="dsh-carousel-side">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="dsh-carousel-detail-btn"
            onClick={() =>
              navigate(
                `/plugins/marketplace/${encodeURIComponent(activeListing.owner)}/${encodeURIComponent(activeListing.pluginName)}`
              )
            }
          >
            {isZh ? '查看详情' : 'View details'}
          </Button>
          {listings.length > 1 ? (
            <div className="dsh-carousel-arrows">
              <button
                type="button"
                className="dsh-carousel-arrow"
                aria-label={
                  isZh ? '上一个推荐插件' : 'Previous featured plugin'
                }
                onClick={() =>
                  setActiveIndex(
                    (prev) => (prev - 1 + listings.length) % listings.length
                  )
                }
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                className="dsh-carousel-arrow"
                aria-label={isZh ? '下一个推荐插件' : 'Next featured plugin'}
                onClick={() =>
                  setActiveIndex((prev) => (prev + 1) % listings.length)
                }
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {listings.length > 1 ? (
        <div className="dsh-carousel-dots" role="group">
          {listings.map((item, idx) => (
            <button
              key={`${item.owner}/${item.pluginName}`}
              type="button"
              className={
                idx === safeIndex
                  ? 'dsh-carousel-dot is-active'
                  : 'dsh-carousel-dot'
              }
              aria-label={`${idx + 1}`}
              onClick={() => setActiveIndex(idx)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PluginMarketplaceLoading({ label }: { label: string }) {
  return (
    <div className="product-plugin-market" role="status" aria-label={label}>
      <div className="product-plugin-underline-tabs" aria-hidden="true">
        <Skeleton className="product-plugin-market-loading-tab w-8" />
        <Skeleton className="product-plugin-market-loading-tab w-12" />
        <Skeleton className="product-plugin-market-loading-tab w-10" />
      </div>
      <div className="product-plugin-market-list">
        <div className="product-plugin-market-grid dsh-market-rows">
          {MARKETPLACE_SKELETON_CARDS.map((card, index) => (
            <div
              className="product-plugin-card product-plugin-card-skeleton dsh-market-row"
              key={index}
            >
              <div className="product-plugin-card-head">
                <Skeleton className="product-plugin-card-logo" />
                <span className="product-plugin-row-copy">
                  <Skeleton className={`h-3.5 ${card.title}`} />
                  <span className="product-plugin-row-tags">
                    <Skeleton className={`h-4 rounded-full ${card.tag}`} />
                    <Skeleton className="h-4 w-9 rounded-full" />
                  </span>
                </span>
              </div>
              <Skeleton className={`h-2.5 ${card.summary}`} />
              <span className="product-plugin-row-actions">
                <Skeleton className="h-7 w-14 rounded-lg" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketplaceRow({
  listing,
  installing,
  installed,
  canInstall,
  onInstall,
}: {
  listing: CatalogListing;
  installing: boolean;
  installed: boolean;
  canInstall: boolean;
  onInstall: (listing: CatalogListing) => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const navigate = useNavigate();
  const displayName = officialListingName(listing, t);
  const resolvedCategory = resolveMarketplaceListingCategory(listing);
  const pluginId = listing.offlinePluginId ?? listing.pluginName;
  return (
    <div
      className="product-plugin-row product-plugin-card dsh-plugin-card dsh-market-row"
      data-market-entry
      data-plugin-category={resolvedCategory}
    >
      <button
        type="button"
        className="product-plugin-open"
        onClick={() =>
          navigate(
            `/plugins/marketplace/${encodeURIComponent(listing.owner)}/${encodeURIComponent(listing.pluginName)}`
          )
        }
      >
        <PluginMarketplaceLogo listing={listing} displayName={displayName} />
        <span className="product-plugin-row-copy">
          <span className="product-plugin-row-title">
            <strong>{displayName}</strong>
          </span>
          <span className="product-plugin-row-summary">
            {officialListingSummary(listing, t)}
          </span>
        </span>
      </button>
      <PluginRowMetaColumns
        pluginId={pluginId}
        owner={listing.owner}
        version={listing.version}
        tag={listing.tag}
        homepage={listing.homepage}
        repo={listing.repo}
        categoryLabel={pluginCategoryLabel(resolvedCategory, t, isZh)}
      />
      <span className="product-plugin-row-actions dsh-row-action-slot">
        {installed ? (
          <span className="product-plugin-installed">
            {t('plugins.installedStatus')}
          </span>
        ) : canInstall ? (
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
        ) : null}
      </span>
    </div>
  );
}
