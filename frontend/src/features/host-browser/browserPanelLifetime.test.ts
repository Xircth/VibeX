import { describe, expect, it } from 'vitest';

import {
  browserPanelSurfaceKey,
  forgetBrowserSurface,
  projectLayoutStillHasBrowserPanel,
  recallBrowserSurface,
  rememberBrowserSurface,
  serializedLayoutHasPanel,
} from './browserPanelLifetime';

const panelId = 'plugin:vibex.browser/browser:1';

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
      serializedLayoutHasPanel(layoutWithPanel, 'plugin:vibex.browser/browser:2')
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
});

describe('live browser surfaces', () => {
  it('remembers a native tab for a panel key', () => {
    const key = browserPanelSurfaceKey('project-a', panelId);
    rememberBrowserSurface(key, {
      tabId: 'tab-1',
      url: 'https://github.com/',
    });
    expect(recallBrowserSurface(key)).toEqual({
      tabId: 'tab-1',
      url: 'https://github.com/',
    });
    forgetBrowserSurface(key);
    expect(recallBrowserSurface(key)).toBeUndefined();
  });
});
