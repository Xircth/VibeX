import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';
import {
  contrastRatio,
  hexToHsl,
  hexToHslTriplet,
  hslToHex,
  parseHexColor,
} from '@/lib/theme/colorMath';
import {
  COLOR_THEME_CHANGED_EVENT,
  getActiveColorTheme,
} from '@/lib/theme/colorThemeStore';

/**
 * Optional accent override on top of the active color theme. With no stored
 * hex the theme's own accent paints `--primary`; a stored hex sets
 * `--accent-hsl` / `--accent-foreground-hsl` on the document root, which every
 * theme block reads before its own accent.
 */
export const ACCENT_COLOR_KEY = 'vibex:accent-color' as const;
export const ACCENT_COLOR_CHANGED_EVENT = 'vibex:accent-color-changed';
export const DEFAULT_ACCENT_COLOR = '#1b1b1b';
export const DEFAULT_DARK_ACCENT_COLOR = '#e7ebef';
export const ACCENT_HSL_VAR = '--accent-hsl';
export const ACCENT_FOREGROUND_HSL_VAR = '--accent-foreground-hsl';
const MIN_DARK_FILL_CONTRAST = 3;
const INK_FOREGROUND_HSL = '0 0% 9.02%';
const PAPER_FOREGROUND_HSL = '0 0% 100%';

export type Hsv = { h: number; s: number; v: number };
type Scheme = 'light' | 'dark';

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The opaque hex in `value`, or null when it holds none. */
export function parseAccentColor(
  value: string | null | undefined
): string | null {
  const match = value ? HEX_PATTERN.exec(value.trim()) : null;
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  return `#${hex}`;
}

/** The user's accent override; null means the active theme decides. */
export function getAccentOverride(): string | null {
  return parseAccentColor(readLocalStorage(ACCENT_COLOR_KEY));
}

export function readDocumentTheme(): Scheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** The accent painting `scheme` right now, override or theme. */
export function getAccentColor(scheme: Scheme = readDocumentTheme()): string {
  const override = getAccentOverride();
  if (override) return resolveAccentForTheme(override, scheme);
  return getActiveColorTheme(scheme).colors.accent ?? DEFAULT_ACCENT_COLOR;
}

function liftAccentForDarkSurface(hex: string, background: string): string {
  if (contrastRatio(hex, background) >= MIN_DARK_FILL_CONTRAST) return hex;
  const { h, s, l } = hexToHsl(hex);
  for (let lightness = Math.min(0.92, l + 0.04); lightness <= 0.92; ) {
    const candidate = hslToHex(h, s, lightness);
    if (contrastRatio(candidate, background) >= MIN_DARK_FILL_CONTRAST) {
      return candidate;
    }
    lightness = Number((lightness + 0.02).toFixed(2));
  }
  return DEFAULT_DARK_ACCENT_COLOR;
}

/** A light-mode ink override reads as Pearl Ink in dark; other hues are only
 * lifted until they stay visible on the dark theme's background. */
export function resolveAccentForTheme(
  hex: string,
  scheme: Scheme,
  background: string = getActiveColorTheme('dark').colors.background
): string {
  const color = parseAccentColor(hex) ?? DEFAULT_ACCENT_COLOR;
  if (scheme !== 'dark') return color;
  if (color === DEFAULT_ACCENT_COLOR) return DEFAULT_DARK_ACCENT_COLOR;
  return liftAccentForDarkSurface(color, background);
}

export function accentForegroundHsl(hex: string): string {
  const paper = contrastRatio('#ffffff', hex);
  const ink = contrastRatio('#171717', hex);
  return paper >= ink ? PAPER_FOREGROUND_HSL : INK_FOREGROUND_HSL;
}

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = parseHexColor(hex) ?? { r: 0, g: 0, b: 0 };
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    switch (max) {
      case red:
        hue = ((green - blue) / delta + (green < blue ? 6 : 0)) * 60;
        break;
      case green:
        hue = ((blue - red) / delta + 2) * 60;
        break;
      default:
        hue = ((red - green) / delta + 4) * 60;
        break;
    }
  }
  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = v - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (h < 60) {
    red = chroma;
    green = x;
  } else if (h < 120) {
    red = x;
    green = chroma;
  } else if (h < 180) {
    green = chroma;
    blue = x;
  } else if (h < 240) {
    green = x;
    blue = chroma;
  } else if (h < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  const toHex = (channel: number) =>
    Math.round((channel + match) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

export function applyAccentColor(scheme: Scheme = readDocumentTheme()): void {
  const root = document.documentElement;
  const override = getAccentOverride();
  if (!override) {
    root.style.removeProperty(ACCENT_HSL_VAR);
    root.style.removeProperty(ACCENT_FOREGROUND_HSL_VAR);
    return;
  }
  const color = resolveAccentForTheme(override, scheme);
  root.style.setProperty(ACCENT_HSL_VAR, hexToHslTriplet(color));
  root.style.setProperty(ACCENT_FOREGROUND_HSL_VAR, accentForegroundHsl(color));
}

function storeAccent(value: string): void {
  writeLocalStorage(ACCENT_COLOR_KEY, value);
  persistFrontendPreference(ACCENT_COLOR_KEY, value);
  applyAccentColor();
  window.dispatchEvent(new CustomEvent(ACCENT_COLOR_CHANGED_EVENT));
}

export function setAccentColor(hex: string): void {
  const color = parseAccentColor(hex);
  if (color) storeAccent(color);
}

/** Drops the override so the active theme's accent shows again. */
export function followThemeAccent(): void {
  storeAccent('');
}

let listenersInstalled = false;

export function initAccentColor(): void {
  applyAccentColor();
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ACCENT_COLOR_KEY) return;
    applyAccentColor();
    window.dispatchEvent(new CustomEvent(ACCENT_COLOR_CHANGED_EVENT));
  });
  window.addEventListener(COLOR_THEME_CHANGED_EVENT, () => applyAccentColor());
}
