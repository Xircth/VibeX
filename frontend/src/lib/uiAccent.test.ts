import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import { clearLocalStorageCache } from './safeStorage';
import { contrastRatio } from './theme/colorMath';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  ACCENT_COLOR_KEY,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_DARK_ACCENT_COLOR,
  accentForegroundHsl,
  applyAccentColor,
  followThemeAccent,
  getAccentColor,
  getAccentOverride,
  hexToHsv,
  hsvToHex,
  initAccentColor,
  parseAccentColor,
  resolveAccentForTheme,
  setAccentColor,
} from './uiAccent';

const root = document.documentElement;

describe('uiAccent', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    persistFrontendPreference.mockReset();
    root.style.removeProperty('--accent-hsl');
    root.style.removeProperty('--accent-foreground-hsl');
  });

  afterEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    root.classList.remove('light', 'dark');
  });

  it('parses hex overrides and treats anything else as no override', () => {
    expect(parseAccentColor('#1B1B1B')).toBe('#1b1b1b');
    expect(parseAccentColor('#abc')).toBe('#aabbcc');
    expect(parseAccentColor('3F6CC4')).toBe('#3f6cc4');
    expect(parseAccentColor('not-a-color')).toBeNull();
    expect(parseAccentColor('')).toBeNull();

    localStorage.setItem(ACCENT_COLOR_KEY, 'nope');
    clearLocalStorageCache(ACCENT_COLOR_KEY);
    expect(getAccentOverride()).toBeNull();
  });

  it('follows the active theme accent when there is no override', () => {
    expect(getAccentColor('light')).toBe(DEFAULT_ACCENT_COLOR);
    expect(getAccentColor('dark')).toBe(DEFAULT_DARK_ACCENT_COLOR);

    initAccentColor();
    expect(root.style.getPropertyValue('--accent-hsl')).toBe('');
  });

  it('picks the readable foreground for an accent fill', () => {
    expect(accentForegroundHsl('#1b1b1b')).toBe('0 0% 100%');
    expect(accentForegroundHsl('#f5f5f5')).toBe('0 0% 9.02%');
    expect(accentForegroundHsl(DEFAULT_DARK_ACCENT_COLOR)).toBe('0 0% 9.02%');
  });

  it('round-trips hex through HSV for saturated and gray colors', () => {
    expect(hsvToHex(hexToHsv('#1b1b1b'))).toBe('#1b1b1b');
    expect(hsvToHex(hexToHsv('#3f6cc4'))).toBe('#3f6cc4');
    expect(hsvToHex(hexToHsv('#ff0000'))).toBe('#ff0000');
  });

  it('persists an override, applies CSS variables, and notifies listeners', () => {
    const listener = vi.fn();
    window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, listener);

    setAccentColor('#3F6CC4');

    expect(getAccentOverride()).toBe('#3f6cc4');
    expect(localStorage.getItem(ACCENT_COLOR_KEY)).toBe('#3f6cc4');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      ACCENT_COLOR_KEY,
      '#3f6cc4'
    );
    expect(root.style.getPropertyValue('--accent-hsl')).toBe(
      '219.7 52.99% 50.78%'
    );
    expect(root.style.getPropertyValue('--accent-foreground-hsl')).toBe(
      '0 0% 100%'
    );
    expect(listener).toHaveBeenCalledOnce();

    window.removeEventListener(ACCENT_COLOR_CHANGED_EVENT, listener);
  });

  it('ignores invalid writes and drops the override on follow-theme', () => {
    setAccentColor('#aabbcc');
    persistFrontendPreference.mockReset();

    setAccentColor('nope');
    expect(getAccentOverride()).toBe('#aabbcc');
    expect(persistFrontendPreference).not.toHaveBeenCalled();

    followThemeAccent();
    expect(getAccentOverride()).toBeNull();
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      ACCENT_COLOR_KEY,
      ''
    );
    expect(root.style.getPropertyValue('--accent-hsl')).toBe('');
  });

  it('maps an ink override to Pearl Ink in dark and keeps custom hues', () => {
    expect(resolveAccentForTheme('#1b1b1b', 'light')).toBe('#1b1b1b');
    expect(resolveAccentForTheme('#1b1b1b', 'dark')).toBe(
      DEFAULT_DARK_ACCENT_COLOR
    );
    expect(resolveAccentForTheme('#3f6cc4', 'dark')).toBe('#3f6cc4');
  });

  it('lifts a dark override until it is visible on the dark background', () => {
    const background = '#0b0e14';
    const resolved = resolveAccentForTheme('#1a365d', 'dark', background);
    expect(resolved).not.toBe('#1a365d');
    expect(contrastRatio(resolved, background)).toBeGreaterThanOrEqual(3);
  });

  it('applies the dark resolution when the document is dark', () => {
    root.classList.add('dark');
    setAccentColor(DEFAULT_ACCENT_COLOR);
    applyAccentColor();

    expect(root.style.getPropertyValue('--accent-hsl')).toBe('210 20% 92.16%');
    expect(root.style.getPropertyValue('--accent-foreground-hsl')).toBe(
      '0 0% 9.02%'
    );
  });
});
