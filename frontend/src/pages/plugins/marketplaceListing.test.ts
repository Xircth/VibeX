import { describe, expect, it } from 'vitest';

import type { CatalogListing } from '@/lib/api/plugins';

import {
  findInstalledPluginForListing,
  flattenMarketplaceListings,
  listingMatchesPlugin,
  listingMatchesSearch,
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
  it('exposes the 8 DSH category tabs and classifies official & community listings into categories', () => {
    const session = listing('vibex', 'vibex.session-enhance', 'ai-enhancement');
    const notes = listing('acme', 'notes', 'community');
    const drawio = listing('vibex', 'drawio', 'design');
    const listings = flattenMarketplaceListings([session], [notes, drawio]);

    expect(listingTopicCategory('official')).toBeNull();
    expect(listingTopicCategory('community')).toBeNull();
    expect(listingTopicCategory('design')).toBe('design');
    expect(listingTopicCategory('ai-enhancement')).toBe('ai-enhancement');
    expect(marketplaceCategoryTabIds(listings)).toEqual([
      'all',
      'design',
      'development',
      'science',
      'ai-enhancement',
      'utilities',
      'aigc',
      'other',
    ]);
    expect(
      listingsInMarketplaceTab(listings, 'ai-enhancement').map(
        (item) => item.pluginName
      )
    ).toEqual(['vibex.session-enhance']);
    expect(
      listingsInMarketplaceTab(listings, 'design').map(
        (item) => item.pluginName
      )
    ).toEqual(['drawio']);
    expect(
      listingsInMarketplaceTab(listings, 'other').map((item) => item.pluginName)
    ).toEqual(['notes']);
    expect(
      listingsInMarketplaceTab(listings, 'all').map((item) => item.pluginName)
    ).toEqual(['vibex.session-enhance', 'notes', 'drawio']);
  });
});

describe('marketplace search', () => {
  it('matches the visible localized name, not only the package display name', () => {
    const office = listing('vibex', 'vibex.office', 'productivity');
    office.displayName = 'VibeX Office';
    office.summary = 'Office files';
    expect(
      listingMatchesSearch(
        office,
        '办公套件',
        '办公套件',
        '在 VibeX 中预览文档'
      )
    ).toBe(true);
    expect(
      listingMatchesSearch(office, 'office', '办公套件', '在 VibeX 中预览文档')
    ).toBe(true);
    expect(
      listingMatchesSearch(office, 'notes', '办公套件', '在 VibeX 中预览文档')
    ).toBe(false);
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
