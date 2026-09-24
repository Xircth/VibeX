import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CatalogListing } from '@/lib/api/plugins';

import {
  allowedMarketplaceIconUrl,
  PluginMarketplaceLogo,
} from './OfficialPluginIcon';

function listing(overrides: Partial<CatalogListing> = {}): CatalogListing {
  return {
    owner: 'acme',
    pluginName: 'notes',
    tag: '1.0.0',
    version: '1.0.0',
    displayName: 'Notes',
    summary: 'Take notes',
    category: 'community',
    sourceKind: 'github',
    ...overrides,
  };
}

describe('PluginMarketplaceLogo', () => {
  it('resolves the Office glyph from owner and pluginName without offlinePluginId', () => {
    const { container } = render(
      <PluginMarketplaceLogo
        listing={listing({ owner: 'vibex', pluginName: 'office' })}
        displayName="办公套件"
      />
    );
    expect(container.querySelector('[data-official="office"]')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.product-plugin-card-initials')).toBeNull();
  });

  it('does not use Puzzle for browser or openConnector official keys', () => {
    const browser = render(
      <PluginMarketplaceLogo
        listing={listing({
          owner: 'vibex',
          pluginName: 'browser',
          offlinePluginId: 'vibex.browser',
        })}
        displayName="Browser"
      />
    );
    expect(
      browser.container.querySelector('[data-official="browser"]')
    ).not.toBeNull();
    expect(
      browser.container.querySelector('[data-official="hostChrome"]')
    ).toBeNull();
    browser.unmount();

    const connector = render(
      <PluginMarketplaceLogo
        listing={listing({
          owner: 'vibex',
          pluginName: 'open-connector',
          offlinePluginId: 'vibex.open-connector',
        })}
        displayName="Open Connector"
      />
    );
    expect(
      connector.container.querySelector('[data-official="openConnector"]')
    ).not.toBeNull();
    expect(
      connector.container.querySelector('[data-official="hostChrome"]')
    ).toBeNull();
  });

  it('renders a contract catalog Lucide name', () => {
    const { container } = render(
      <PluginMarketplaceLogo
        listing={listing({ icon: 'globe' })}
        displayName="Notes"
      />
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.product-plugin-card-initials')).toBeNull();
  });

  it('renders an allowlisted marketplace bitmap', () => {
    const { container } = render(
      <PluginMarketplaceLogo
        listing={listing({ icon: 'https://vibex.xforever.xin/foo.png' })}
        displayName="Notes"
      />
    );
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('rejects untrusted icon urls and falls back to initials', () => {
    expect(allowedMarketplaceIconUrl('http://vibex.xforever.xin/foo.png')).toBeNull();
    expect(
      allowedMarketplaceIconUrl('https://github.com/acme/notes/icon.png')
    ).toBeNull();
    expect(
      allowedMarketplaceIconUrl('https://user:pass@vibex.xforever.xin/foo.png')
    ).toBeNull();
    expect(
      allowedMarketplaceIconUrl('https://vibex.xforever.xin:8080/foo.png')
    ).toBeNull();
    expect(
      allowedMarketplaceIconUrl('https://vibex.xforever.xin/foo.svg')
    ).toBeNull();
    expect(
      allowedMarketplaceIconUrl('https://vibex.xforever.xin/foo.svg?download=1')
    ).toBeNull();

    const { container } = render(
      <PluginMarketplaceLogo
        listing={listing({ icon: 'https://github.com/acme/notes/icon.png' })}
        displayName="Notes"
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.product-plugin-card-initials')).toHaveTextContent(
      'NO'
    );
  });

  it('falls back to initials when a bitmap fails to load', () => {
    const { container } = render(
      <PluginMarketplaceLogo
        listing={listing({ icon: 'https://vibex.xforever.xin/foo.png' })}
        displayName="Notes"
      />
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('.product-plugin-card-initials')).toHaveTextContent(
      'NO'
    );
  });
});
