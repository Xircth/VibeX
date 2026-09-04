import { describe, expect, it } from 'vitest';
import {
  fallbackWorkspaceTab,
  parsePluginSurfaceId,
  pluginSurfaceId,
} from './hostSurfaceIds';

describe('hostSurfaceIds', () => {
  it('namespaces plugin surfaces', () => {
    expect(pluginSurfaceId('vibex.host-surface', 'sample-tab')).toBe(
      'plugin:vibex.host-surface/sample-tab'
    );
    expect(parsePluginSurfaceId('plugin:vibex.host-surface/sample-tab')).toEqual({
      pluginId: 'vibex.host-surface',
      contributionId: 'sample-tab',
    });
  });

  it('falls back to workspace when a plugin tab disappears', () => {
    expect(
      fallbackWorkspaceTab('plugin:gone/tab', ['kanban', 'workspace'])
    ).toBe('workspace');
    expect(
      fallbackWorkspaceTab('plugin:live/tab', [
        'workspace',
        'plugin:live/tab',
      ])
    ).toBe('plugin:live/tab');
  });
});
