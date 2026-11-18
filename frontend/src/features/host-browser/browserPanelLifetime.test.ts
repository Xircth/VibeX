import { describe, expect, it } from 'vitest';

import {
  browserPanelSurfaceKey,
  forgetBrowserSurface,
  projectLayoutStillHasBrowserPanel,
  recallBrowserSurface,
  rememberBrowserSurface,
  serializedLayoutHasPanel,
} from './browserPanelLifetime';

const panelId = 'plugin:dimo.browser/browser:1';

const layoutWithPanel = {
  panels: {
    [panelId]: { id: panelId, contentComponent: 'plugin-panel' },
  },
  grid: {
    root: {
      type: 'leaf',
      data: { views: [panelId], id: 'group-editor-1' },
    },
  },
};

describe('serializedLayoutHasPanel', () => {
  it('finds a panel in the dockview snapshot', () => {
    expect(serializedLayoutHasPanel(layoutWithPanel, panelId)).toBe(true);
    expect(
      serializedLayoutHasPanel(layoutWithPanel, 'plugin:dimo.browser/browser:2')
    ).toBe(false);
    expect(serializedLayoutHasPanel(null, panelId)).toBe(false);
  });
});

describe('projectLayoutStillHasBrowserPanel', () => {
  it('keeps a panel that was saved with the project being left', () => {
    expect(
      projectLayoutStillHasBrowserPanel(
        {
          currentProjectKey: 'project-b',
          serializedLayout: { panels: {} },
          projectLayouts: {
            'project-a': { serializedLayout: layoutWithPanel },
          },
        },
        'project-a',
        panelId
      )
    ).toBe(true);
  });

  it('drops a panel the current layout no longer lists', () => {
    expect(
      projectLayoutStillHasBrowserPanel(
        {
          currentProjectKey: 'project-a',
          serializedLayout: { panels: {} },
          projectLayouts: {
            'project-a': { serializedLayout: { panels: {} } },
          },
        },
        'project-a',
        panelId
      )
    ).toBe(false);
  });
  it('drops a closed panel on the active project even when projectLayouts holds an older snapshot', () => {
    expect(
      projectLayoutStillHasBrowserPanel(
        {
          currentProjectKey: 'project-a',
          serializedLayout: { panels: {} },
          projectLayouts: {
            'project-a': { serializedLayout: layoutWithPanel },
          },
        },
        'project-a',
        panelId
      )
    ).toBe(false);
  });
});

describe('live browser surfaces', () => {
  it('remembers a native tab for a panel key and isolates canvas vs dockview surfaces', async () => {
    const { clearAllBrowserSurfaces } = await import('./browserPanelLifetime');
    const dockKey = browserPanelSurfaceKey('project-a', panelId, 'dockview');
    const canvasKey = browserPanelSurfaceKey('project-a', panelId, 'canvas');
    expect(dockKey).not.toBe(canvasKey);

    rememberBrowserSurface(dockKey, {
      tabId: 'tab-dock',
      url: 'https://github.com/',
    });
    rememberBrowserSurface(canvasKey, {
      tabId: 'tab-canvas',
      url: 'https://example.com/',
    });
    expect(recallBrowserSurface(dockKey)).toEqual({
      tabId: 'tab-dock',
      url: 'https://github.com/',
    });
    expect(recallBrowserSurface(canvasKey)).toEqual({
      tabId: 'tab-canvas',
      url: 'https://example.com/',
    });

    forgetBrowserSurface(dockKey);
    expect(recallBrowserSurface(dockKey)).toBeUndefined();
    expect(recallBrowserSurface(canvasKey)?.tabId).toBe('tab-canvas');

    clearAllBrowserSurfaces();
    expect(recallBrowserSurface(canvasKey)).toBeUndefined();
  });
});
