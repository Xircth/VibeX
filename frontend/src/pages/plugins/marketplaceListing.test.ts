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
    const session = listing('dimo', 'dimo.session-enhance', 'ai-enhancement');
    const notes = listing('acme', 'notes', 'community');
    const drawio = listing('dimo', 'drawio', 'design');
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
    ).toEqual(['dimo.session-enhance']);
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
    ).toEqual(['dimo.session-enhance', 'notes', 'drawio']);
  });
});

describe('marketplace search', () => {
  it('matches the visible localized name, not only the package display name', () => {
    const office = listing('dimo', 'dimo.office', 'productivity');
    office.displayName = 'Dimo Office';
    office.summary = 'Office files';
    expect(
      listingMatchesSearch(
        office,
        '办公套件',
        '办公套件',
        '在 Dimo 中预览文档'
      )
    ).toBe(true);
    expect(
      listingMatchesSearch(office, 'office', '办公套件', '在 Dimo 中预览文档')
    ).toBe(true);
    expect(
      listingMatchesSearch(office, 'notes', '办公套件', '在 Dimo 中预览文档')
    ).toBe(false);
  });
});

describe('marketplace installed matching', () => {
  it('treats publisher-prefixed and bare plugin ids as the same product', () => {
    expect(pluginIdentitiesMatch('office', 'dimo.office')).toBe(true);
    expect(pluginIdentitiesMatch('dimo.office', 'office')).toBe(true);
    expect(pluginIdentitiesMatch('dimo.office', 'dimo.office')).toBe(true);
    expect(pluginIdentitiesMatch('notes', 'dimo.office')).toBe(false);
  });

  it('matches an installed catalog plugin to its marketplace listing', () => {
    expect(
      listingMatchesPlugin(
        { owner: 'dimo', pluginName: 'dimo.office' },
        { id: 'office', publisher: 'dimo' }
      )
    ).toBe(true);
    expect(
      listingMatchesPlugin(
        { owner: 'dimo', pluginName: 'dimo.office' },
        { id: 'dimo.office' }
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
        { id: 'office', publisher: 'dimo' }
      )
    ).toBe(false);
  });

  it('finds the installed plugin for a listing', () => {
    const office = { id: 'office', publisher: 'dimo' };
    const notes = { id: 'notes', publisher: 'acme' };
    expect(
      findInstalledPluginForListing(
        { owner: 'dimo', pluginName: 'dimo.office' },
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
