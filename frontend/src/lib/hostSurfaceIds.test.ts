import { describe, expect, it } from 'vitest';
import {
  fallbackWorkspaceTab,
  parsePluginSurfaceId,
  pluginSurfaceId,
  shouldOpenContributedPanel,
} from './hostSurfaceIds';

describe('hostSurfaceIds', () => {
  it('namespaces plugin surfaces', () => {
    expect(pluginSurfaceId('vibex.host-surface', 'sample-tab')).toBe(
      'plugin:vibex.host-surface/sample-tab'
    );
    expect(
      parsePluginSurfaceId('plugin:vibex.host-surface/sample-tab')
    ).toEqual({
      pluginId: 'vibex.host-surface',
      contributionId: 'sample-tab',
    });
    expect(pluginSurfaceId('vibex.browser', 'browser', 2)).toBe(
      'plugin:vibex.browser/browser:2'
    );
    expect(parsePluginSurfaceId('plugin:vibex.browser/browser:2')).toEqual({
      pluginId: 'vibex.browser',
      contributionId: 'browser',
      instance: '2',
    });
  });

  it('falls back to workspace when a plugin tab disappears', () => {
    expect(
      fallbackWorkspaceTab('plugin:gone/tab', ['kanban', 'workspace'])
    ).toBe('workspace');
    expect(
      fallbackWorkspaceTab('plugin:live/tab', ['workspace', 'plugin:live/tab'])
    ).toBe('plugin:live/tab');
  });

  it('opens a contributed panel once until it leaves the catalog', () => {
    expect(shouldOpenContributedPanel(false, false)).toBe(true);
    expect(shouldOpenContributedPanel(true, false)).toBe(false);
    expect(shouldOpenContributedPanel(false, true)).toBe(false);
  });
});
