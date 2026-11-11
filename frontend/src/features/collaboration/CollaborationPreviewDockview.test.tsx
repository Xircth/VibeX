import { describe, expect, it } from 'vitest';
import { panelRegistry } from '@vibex/plugin-sdk';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { COLLABORATION_PREVIEW_COMPONENTS } from './CollaborationPreviewDockview';

describe('COLLABORATION_PREVIEW_COMPONENTS', () => {
  it('resolves builtin workspace panels and collaboration overrides when PanelRegistry is evaluated first', () => {
    expect(typeof panelComponents[PANEL_IDS.NOTES]).toBe('function');
    expect(COLLABORATION_PREVIEW_COMPONENTS[PANEL_IDS.NOTES]).toBe(
      panelComponents[PANEL_IDS.NOTES]
    );
    expect(typeof COLLABORATION_PREVIEW_COMPONENTS['member-session']).toBe(
      'function'
    );
    expect(typeof COLLABORATION_PREVIEW_COMPONENTS['file-preview']).toBe(
      'function'
    );
    expect(typeof COLLABORATION_PREVIEW_COMPONENTS['space-collection']).toBe(
      'function'
    );
  });

  it('forwards dynamic plugin panel lookups through panelComponents proxy', () => {
    const dispose = panelRegistry.register(
      {
        id: 'acme.demo:custom-preview',
        pluginId: 'acme.demo',
        title: 'Custom Preview',
        zone: 'editor',
        component: () => null,
      },
      'acme.demo'
    );

    try {
      expect('plugin:acme.demo/custom-preview' in COLLABORATION_PREVIEW_COMPONENTS).toBe(true);
      expect(
        typeof COLLABORATION_PREVIEW_COMPONENTS['plugin:acme.demo/custom-preview']
      ).toBe('function');
    } finally {
      dispose();
    }
  });
});
