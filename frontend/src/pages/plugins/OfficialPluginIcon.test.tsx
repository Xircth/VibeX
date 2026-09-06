import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PluginProductIcon } from './OfficialPluginIcon';
import { OFFICIAL_PLUGIN_I18N_KEY } from './officialPlugins';

describe('PluginProductIcon', () => {
  it('renders an svg for every official plugin id', () => {
    for (const pluginId of Object.keys(OFFICIAL_PLUGIN_I18N_KEY)) {
      const { container, unmount } = render(
        <PluginProductIcon pluginId={pluginId} />
      );
      expect(
        container.querySelector('svg'),
        `${pluginId} must have a glyph`
      ).not.toBeNull();
      unmount();
    }
  });

  it('falls back for unknown plugins instead of rendering nothing', () => {
    const { container } = render(
      <PluginProductIcon pluginId="third.party.unknown" />
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
