import { describe, expect, it } from 'vitest';

import type { CatalogListing } from '@/lib/api/plugins';

import {
  flattenMarketplaceListings,
  listingsInMarketplaceTab,
  listingTopicCategory,
  marketplaceCategoryTabIds,
} from './marketplaceListing';

function listing(
  owner: string,
  pluginName: string,
  category: string
): CatalogListing {
  return {
    owner,
    pluginName,
    tag: '1.0.0',
    version: '1.0.0',
    displayName: pluginName,
    summary: pluginName,
    category,
    sourceKind: 'official',
  };
}

describe('marketplace listing categories', () => {
  it('treats official as the vibex owner and topics as real categories', () => {
    const session = listing('vibex', 'vibex.session-enhance', 'productivity');
    const notes = listing('acme', 'notes', 'community');
    const drawio = listing('vibex', 'drawio', 'productivity');
    const listings = flattenMarketplaceListings([session], [notes, drawio]);

    expect(listingTopicCategory('official')).toBeNull();
    expect(listingTopicCategory('community')).toBeNull();
    expect(listingTopicCategory('productivity')).toBe('productivity');
    expect(marketplaceCategoryTabIds(listings)).toEqual([
      'all',
      'official',
      'productivity',
    ]);
    expect(
      listingsInMarketplaceTab(listings, 'official').map(
        (item) => item.pluginName
      )
    ).toEqual(['vibex.session-enhance', 'drawio']);
    expect(
      listingsInMarketplaceTab(listings, 'productivity').map(
        (item) => item.pluginName
      )
    ).toEqual(['vibex.session-enhance', 'drawio']);
    expect(
      listingsInMarketplaceTab(listings, 'all').map((item) => item.pluginName)
    ).toEqual(['vibex.session-enhance', 'notes', 'drawio']);
  });
});
