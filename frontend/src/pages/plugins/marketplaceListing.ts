import type { CatalogListing } from '@/lib/api/plugins';

export const OFFICIAL_MARKETPLACE_OWNER = 'vibex';

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
