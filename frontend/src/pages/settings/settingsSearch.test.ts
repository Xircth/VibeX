import { describe, expect, it, vi } from 'vitest';

import {
  applySettingsSearchHighlight,
  findSettingsHighlightTarget,
  matchSettingsSearch,
} from './settingsSearchQuery';

const entries = [
  {
    id: 'appearance.theme.label',
    path: '/settings/appearance',
    labelKey: 'appearance.theme.label',
    groupKey: 'appearance',
    label: 'App theme',
    group: 'Appearance',
  },
  {
    id: 'general.defaultTerminal',
    path: '/settings/general',
    labelKey: 'general.defaultTerminal',
    groupKey: 'general',
    label: 'Default terminal',
    group: 'General',
  },
];

describe('matchSettingsSearch', () => {
  it('filters settings by label or group', () => {
    expect(
      matchSettingsSearch(entries, 'theme').map((entry) => entry.id)
    ).toEqual(['appearance.theme.label']);
    expect(
      matchSettingsSearch(entries, 'general').map((entry) => entry.id)
    ).toEqual(['general.defaultTerminal']);
    expect(matchSettingsSearch(entries, '  ')).toEqual([]);
  });
});

describe('settings search highlight', () => {
  it('finds the setting label and applies a yellow flash class', () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const root = document.createElement('div');
    root.innerHTML = `
      <section>
        <h3>Terminal</h3>
        <label>Default terminal</label>
      </section>
    `;
    const label = findSettingsHighlightTarget(root, 'Default terminal');
    expect(label?.tagName).toBe('LABEL');
    const flashed = applySettingsSearchHighlight(root, 'Default terminal');
    expect(flashed).toBe(label);
    expect(flashed).toHaveClass('settings-search-flash');
  });
});
