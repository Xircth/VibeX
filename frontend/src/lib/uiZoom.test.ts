import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearLocalStorageCache } from './safeStorage';
import { applyUiZoom, getUiZoom, UI_ZOOM_KEY, UI_ZOOM_LEVELS } from './uiZoom';

vi.mock('./frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

afterEach(() => {
  localStorage.removeItem(UI_ZOOM_KEY);
  clearLocalStorageCache(UI_ZOOM_KEY);
  document.documentElement.style.removeProperty('zoom');
  document.documentElement.style.removeProperty('font-size');
  document.documentElement.style.removeProperty('--ui-zoom');
});

describe('applyUiZoom', () => {
  it('does not use CSS zoom, which breaks overlay coordinates', () => {
    document.documentElement.style.setProperty('zoom', '1.25');

    applyUiZoom(1.1);

    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--ui-zoom')).toBe(
      '1.1'
    );
  });

  it('scales the rem root in non-Tauri runtimes instead of CSS zoom', () => {
    applyUiZoom(1.25);

    expect(document.documentElement.style.fontSize).toBe('125%');
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
  });

  it('clears the rem root scale at 100%', () => {
    document.documentElement.style.fontSize = '125%';

    applyUiZoom(1);

    expect(document.documentElement.style.fontSize).toBe('');
    expect(document.documentElement.style.getPropertyValue('--ui-zoom')).toBe(
      '1'
    );
  });
});

describe('getUiZoom', () => {
  it('returns the persisted level when it is supported', () => {
    localStorage.setItem(UI_ZOOM_KEY, '1.25');
    expect(getUiZoom()).toBe(1.25);
    expect(UI_ZOOM_LEVELS).toContain(1.25);
  });

  it('falls back to 1 when the stored value is not a supported level', () => {
    localStorage.setItem(UI_ZOOM_KEY, '2');
    expect(getUiZoom()).toBe(1);
  });
});
