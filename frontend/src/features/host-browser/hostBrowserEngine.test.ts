import { describe, expect, it } from 'vitest';

import {
  findHostBrowserContribution,
  HOST_BROWSER_CONTRIBUTION_ID,
  HOST_BROWSER_PLUGIN_ID,
  isHostBrowserEngine,
} from './hostBrowserEngine';

describe('isHostBrowserEngine', () => {
  it('matches the host-browser engine even before catalog metadata arrives', () => {
    expect(isHostBrowserEngine(HOST_BROWSER_PLUGIN_ID)).toBe(true);
    expect(isHostBrowserEngine(HOST_BROWSER_PLUGIN_ID, {})).toBe(true);
    expect(
      isHostBrowserEngine('example.browser', { engine: 'host-browser' })
    ).toBe(true);
  });

  it('ignores other plugin panels', () => {
    expect(isHostBrowserEngine('vibex.open-connector')).toBe(false);
    expect(isHostBrowserEngine('vibex.browser.tools', { engine: 'iframe' })).toBe(
      false
    );
  });

  it('finds the official browser contribution from catalog metadata', () => {
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
          pluginId: HOST_BROWSER_PLUGIN_ID,
          id: HOST_BROWSER_CONTRIBUTION_ID,
        },
      ])?.id
    ).toBe(HOST_BROWSER_CONTRIBUTION_ID);
  });
});
