import { describe, expect, it } from 'vitest';

import {
  findHostBrowserContribution,
  isHostBrowserEngine,
} from './hostBrowserEngine';

describe('isHostBrowserEngine', () => {
  it('matches any plugin that declares the host-browser engine', () => {
    expect(
      isHostBrowserEngine('example.browser', { engine: 'host-browser' })
    ).toBe(true);
    expect(isHostBrowserEngine('example.browser')).toBe(false);
    expect(isHostBrowserEngine('example.browser', {})).toBe(false);
  });

  it('ignores other plugin panels', () => {
    expect(isHostBrowserEngine('acme.connector')).toBe(false);
    expect(isHostBrowserEngine('acme.preview', { engine: 'iframe' })).toBe(
      false
    );
  });

  it('finds the host-browser contribution from catalog metadata', () => {
    const found = findHostBrowserContribution([
      {
        pluginId: 'example.browser',
        id: 'browser',
        metadata: { engine: 'host-browser' },
      },
    ]);
    expect(found?.pluginId).toBe('example.browser');
    expect(
      findHostBrowserContribution([
        {
          pluginId: 'acme.other',
          id: 'browser',
        },
      ])
    ).toBeUndefined();
  });
});
