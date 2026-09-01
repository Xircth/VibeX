import { describe, expect, it } from 'vitest';

import type { CatalogListing } from '@/lib/api/plugins';

import {
  findInstalledPluginForListing,
  flattenMarketplaceListings,
  listingMatchesPlugin,
  listingsInMarketplaceTab,
  listingTopicCategory,
  marketplaceCategoryTabIds,
  pluginIdentitiesMatch,
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

describe('marketplace installed matching', () => {
  it('treats publisher-prefixed and bare plugin ids as the same product', () => {
    expect(pluginIdentitiesMatch('office', 'vibex.office')).toBe(true);
    expect(pluginIdentitiesMatch('vibex.office', 'office')).toBe(true);
    expect(pluginIdentitiesMatch('vibex.office', 'vibex.office')).toBe(true);
    expect(pluginIdentitiesMatch('notes', 'vibex.office')).toBe(false);
  });

  it('matches an installed catalog plugin to its marketplace listing', () => {
    expect(
      listingMatchesPlugin(
        { owner: 'vibex', pluginName: 'vibex.office' },
        { id: 'office', publisher: 'vibex' }
      )
    ).toBe(true);
    expect(
      listingMatchesPlugin(
        { owner: 'vibex', pluginName: 'vibex.office' },
        { id: 'vibex.office' }
      )
    ).toBe(true);
    expect(
      listingMatchesPlugin(
        {
          owner: 'acme',
          pluginName: 'notes',
          offlinePluginId: 'acme.notes',
        },
        { id: 'acme.notes' }
      )
    ).toBe(true);
    expect(
      listingMatchesPlugin(
        { owner: 'acme', pluginName: 'notes' },
        {
          id: 'journal',
          sourceOrigin: 'https://vibex.xforever.xin/marketplace/acme/notes',
        }
      )
    ).toBe(true);
    expect(
      listingMatchesPlugin(
        { owner: 'acme', pluginName: 'notes' },
        { id: 'office', publisher: 'vibex' }
      )
    ).toBe(false);
  });

  it('finds the installed plugin for a listing', () => {
    const office = { id: 'office', publisher: 'vibex' };
    const notes = { id: 'notes', publisher: 'acme' };
    expect(
      findInstalledPluginForListing(
        { owner: 'vibex', pluginName: 'vibex.office' },
        [office, notes]
      )
    ).toBe(office);
    expect(
      findInstalledPluginForListing({ owner: 'acme', pluginName: 'notes' }, [
        office,
      ])
    ).toBeUndefined();
  });
});
