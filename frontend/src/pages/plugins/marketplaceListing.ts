import type { CatalogListing, PluginControlItem } from '@/lib/api/plugins';

export const OFFICIAL_MARKETPLACE_OWNER = 'vibex';

export type MarketplaceListingIdentity = Pick<
  CatalogListing,
  'owner' | 'pluginName'
> & {
  offlinePluginId?: string | null;
};

export type InstalledPluginIdentity = Pick<
  PluginControlItem,
  'id' | 'publisher' | 'sourceOrigin'
>;

const CHANNEL_CATEGORIES = new Set(['official', 'community']);

export function isOfficialMarketplaceOwner(owner: string) {
  return owner.trim().toLowerCase() === OFFICIAL_MARKETPLACE_OWNER;
}

export function listingTopicCategory(category: string | null | undefined) {
  const value = category?.trim() ?? '';
  if (!value) return null;
  if (CHANNEL_CATEGORIES.has(value.toLowerCase())) return null;
  return value;
}

export function flattenMarketplaceListings(
  official: CatalogListing[],
  community: CatalogListing[]
) {
  const seen = new Set<string>();
  const listings: CatalogListing[] = [];
  for (const listing of [...official, ...community]) {
    const key = `${listing.owner}/${listing.pluginName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listings.push(listing);
  }
  return listings;
}

export function marketplaceCategoryTabIds(listings: CatalogListing[]) {
  const topics = new Set<string>();
  for (const listing of listings) {
    const topic = listingTopicCategory(listing.category);
    if (topic) topics.add(topic);
  }
  return [
    'all',
    'official',
    ...[...topics].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    ),
  ];
}

export function listingsInMarketplaceTab(
  listings: CatalogListing[],
  tab: string
) {
  if (tab === 'all') return listings;
  if (tab === 'official') {
    return listings.filter((listing) =>
      isOfficialMarketplaceOwner(listing.owner)
    );
  }
  return listings.filter(
    (listing) => listingTopicCategory(listing.category) === tab
  );
}

function identityKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function identitySuffix(value: string) {
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(index + 1) : '';
}

export function pluginIdentitiesMatch(left: string, right: string) {
  const a = identityKey(left);
  const b = identityKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aSuffix = identitySuffix(a);
  const bSuffix = identitySuffix(b);
  return (
    (Boolean(bSuffix) && a === bSuffix) || (Boolean(aSuffix) && b === aSuffix)
  );
}

function listingPackageIds(listing: MarketplaceListingIdentity) {
  const ids = [listing.offlinePluginId, listing.pluginName];
  const owner = listing.owner.trim();
  const pluginName = listing.pluginName.trim();
  if (owner && pluginName) {
    ids.push(`${owner}.${pluginName}`);
  }
  return ids.filter((value): value is string => Boolean(value?.trim()));
}

function originMatchesListing(
  origin: string,
  listing: MarketplaceListingIdentity
) {
  const lower = origin.trim().toLowerCase().replace(/\/+$/, '');
  if (!lower) return false;
  const owner = identityKey(listing.owner);
  const names = listingPackageIds(listing).map(identityKey);
  return names.some(
    (name) =>
      Boolean(name) &&
      (lower.endsWith(`/marketplace/${owner}/${name}`) ||
        lower.includes(`/marketplace/${owner}/${name}/`))
  );
}

export function listingMatchesPlugin(
  listing: MarketplaceListingIdentity,
  plugin: InstalledPluginIdentity
) {
  if (
    listingPackageIds(listing).some((id) =>
      pluginIdentitiesMatch(plugin.id, id)
    )
  ) {
    return true;
  }
  return Boolean(
    plugin.sourceOrigin && originMatchesListing(plugin.sourceOrigin, listing)
  );
}

export function findInstalledPluginForListing<
  T extends InstalledPluginIdentity,
>(listing: MarketplaceListingIdentity, plugins: T[]) {
  return plugins.find((plugin) => listingMatchesPlugin(listing, plugin));
}
