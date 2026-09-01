import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import { clearLocalStorageCache } from './safeStorage';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  ACCENT_COLOR_KEY,
  DEFAULT_ACCENT_COLOR,
  accentForegroundHsl,
  applyAccentColor,
  getAccentColor,
  hexToHslComponents,
  hexToHsv,
  hsvToHex,
  initAccentColor,
  parseAccentColor,
  setAccentColor,
} from './uiAccent';

describe('uiAccent', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache(ACCENT_COLOR_KEY);
    persistFrontendPreference.mockReset();
    document.documentElement.style.removeProperty('--accent-hsl');
    document.documentElement.style.removeProperty('--accent-foreground-hsl');
  });

  afterEach(() => {
    localStorage.clear();
    clearLocalStorageCache(ACCENT_COLOR_KEY);
  });

  it('defaults to graphite #171717 and ignores invalid stored values', () => {
    expect(getAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
    expect(parseAccentColor('#171717')).toBe('#171717');
    expect(parseAccentColor('#abc')).toBe('#aabbcc');
    expect(parseAccentColor('3F6CC4')).toBe('#3f6cc4');
    expect(parseAccentColor('not-a-color')).toBe(DEFAULT_ACCENT_COLOR);
    expect(parseAccentColor('')).toBe(DEFAULT_ACCENT_COLOR);

    localStorage.setItem(ACCENT_COLOR_KEY, 'nope');
    clearLocalStorageCache(ACCENT_COLOR_KEY);
    expect(getAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });

  it('converts the default accent to HSL components and white foreground', () => {
    expect(hexToHslComponents('#171717')).toBe('0 0% 9.02%');
    expect(accentForegroundHsl('#171717')).toBe('0 0% 100%');
    expect(hexToHslComponents('#3F6CC4')).toBe('219.7 52.99% 50.78%');
    expect(accentForegroundHsl('#f5f5f5')).toBe('0 0% 9.02%');
  });

  it('round-trips hex through HSV for saturated and gray colors', () => {
    expect(hsvToHex(hexToHsv('#171717'))).toBe('#171717');
    expect(hsvToHex(hexToHsv('#3f6cc4'))).toBe('#3f6cc4');
    expect(hsvToHex(hexToHsv('#ff0000'))).toBe('#ff0000');
  });

  it('persists a valid color, applies CSS variables, and notifies listeners', () => {
    const listener = vi.fn();
    window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, listener);

    setAccentColor('#3F6CC4');

    expect(getAccentColor()).toBe('#3f6cc4');
    expect(localStorage.getItem(ACCENT_COLOR_KEY)).toBe('#3f6cc4');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      ACCENT_COLOR_KEY,
      '#3f6cc4'
    );
    expect(
      document.documentElement.style.getPropertyValue('--accent-hsl')
    ).toBe('219.7 52.99% 50.78%');
    expect(
      document.documentElement.style.getPropertyValue('--accent-foreground-hsl')
    ).toBe('0 0% 100%');
    expect(listener).toHaveBeenCalledOnce();

    window.removeEventListener(ACCENT_COLOR_CHANGED_EVENT, listener);
  });

  it('applies the stored accent on init and ignores invalid writes', () => {
    localStorage.setItem(ACCENT_COLOR_KEY, '#aabbcc');
    clearLocalStorageCache(ACCENT_COLOR_KEY);

    initAccentColor();

    expect(
      document.documentElement.style.getPropertyValue('--accent-hsl')
    ).toBe(hexToHslComponents('#aabbcc'));

    setAccentColor('nope');
    expect(getAccentColor()).toBe('#aabbcc');
    expect(persistFrontendPreference).not.toHaveBeenCalled();
  });

  it('applies a color without persisting when asked', () => {
    applyAccentColor('#ffffff');
    expect(
      document.documentElement.style.getPropertyValue('--accent-foreground-hsl')
    ).toBe('0 0% 9.02%');
    expect(localStorage.getItem(ACCENT_COLOR_KEY)).toBeNull();
  });
});
