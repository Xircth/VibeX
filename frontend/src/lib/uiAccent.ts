import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

/**
 * User-configurable accent color. Frontend-only, persisted like zoom/font.
 * Drives `--accent-hsl` / `--accent-foreground-hsl` on the document root so
 * `--primary` and filled-control foreground follow the chosen hex.
 */
export const ACCENT_COLOR_KEY = 'vibex:accent-color' as const;
export const ACCENT_COLOR_CHANGED_EVENT = 'vibex:accent-color-changed';
export const DEFAULT_ACCENT_COLOR = '#171717';
export const DEFAULT_DARK_ACCENT_COLOR = '#e7ebef';
export const HANGAR_COLOR = '#0e1319';
export const ACCENT_HSL_VAR = '--accent-hsl';
export const ACCENT_FOREGROUND_HSL_VAR = '--accent-foreground-hsl';
const MIN_DARK_FILL_CONTRAST = 3;

export type Hsv = { h: number; s: number; v: number };

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function formatNumber(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function parseAccentColor(value: string | null | undefined): string {
  if (!value) return DEFAULT_ACCENT_COLOR;
  const match = HEX_PATTERN.exec(value.trim());
  if (!match) return DEFAULT_ACCENT_COLOR;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  return `#${hex}`;
}

export function getAccentColor(): string {
  return parseAccentColor(readLocalStorage(ACCENT_COLOR_KEY));
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = parseAccentColor(hex).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

export function hexToHslComponents(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (max !== min) {
    const delta = max - min;
    saturation =
      lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case red:
        hue = (green - blue) / delta + (green < blue ? 6 : 0);
        break;
      case green:
        hue = (blue - red) / delta + 2;
        break;
      default:
        hue = (red - green) / delta + 4;
        break;
    }
    hue /= 6;
  }

  return `${formatNumber(hue * 360, 1)} ${formatNumber(saturation * 100, 2)}% ${formatNumber(lightness * 100, 2)}%`;
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

function contrastRatio(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (max !== min) {
    const delta = max - min;
    saturation =
      lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case red:
        hue = (green - blue) / delta + (green < blue ? 6 : 0);
        break;
      case green:
        hue = (blue - red) / delta + 2;
        break;
      default:
        hue = (red - green) / delta + 4;
        break;
    }
    hue /= 6;
  }

  return { h: hue * 360, s: saturation, l: lightness };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
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

export function contrastAgainstHangar(hex: string): number {
  const fill = hexToRgb(hex);
  const hangar = hexToRgb(HANGAR_COLOR);
  return contrastRatio(
    relativeLuminance(fill.r, fill.g, fill.b),
    relativeLuminance(hangar.r, hangar.g, hangar.b)
  );
}

function liftAccentForDarkSurface(hex: string): string {
  if (contrastAgainstHangar(hex) >= MIN_DARK_FILL_CONTRAST) {
    return hex;
  }
  const { h, s, l } = hexToHsl(hex);
  for (let lightness = Math.min(0.92, l + 0.04); lightness <= 0.92; ) {
    const candidate = hslToHex(h, s, lightness);
    if (contrastAgainstHangar(candidate) >= MIN_DARK_FILL_CONTRAST) {
      return candidate;
    }
    lightness = Number((lightness + 0.02).toFixed(2));
  }
  return DEFAULT_DARK_ACCENT_COLOR;
}

export function resolveAccentForTheme(
  hex: string,
  theme: 'light' | 'dark'
): string {
  const color = parseAccentColor(hex);
  if (theme !== 'dark') return color;
  if (color === DEFAULT_ACCENT_COLOR) return DEFAULT_DARK_ACCENT_COLOR;
  return liftAccentForDarkSurface(color);
}

export function readDocumentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function accentForegroundHsl(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const luminance = relativeLuminance(r, g, b);
  const whiteContrast = contrastRatio(luminance, 1);
  const blackContrast = contrastRatio(luminance, 0);
  return whiteContrast >= blackContrast ? '0 0% 100%' : '0 0% 9.02%';
}

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = hexToRgb(hex);
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

export function applyAccentColor(
  hex: string,
  theme: 'light' | 'dark' = readDocumentTheme()
): void {
  const color = resolveAccentForTheme(hex, theme);
  const root = document.documentElement;
  root.style.setProperty(ACCENT_HSL_VAR, hexToHslComponents(color));
  root.style.setProperty(ACCENT_FOREGROUND_HSL_VAR, accentForegroundHsl(color));
}

export function setAccentColor(hex: string): void {
  const normalized = hex.trim();
  if (!HEX_PATTERN.test(normalized)) return;
  const color = parseAccentColor(normalized);
  writeLocalStorage(ACCENT_COLOR_KEY, color);
  persistFrontendPreference(ACCENT_COLOR_KEY, color);
  applyAccentColor(color);
  window.dispatchEvent(new CustomEvent(ACCENT_COLOR_CHANGED_EVENT));
}

let storageListenerInstalled = false;

export function initAccentColor(): void {
  applyAccentColor(getAccentColor());
  if (storageListenerInstalled || typeof window === 'undefined') return;
  storageListenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ACCENT_COLOR_KEY) return;
    applyAccentColor(parseAccentColor(event.newValue));
  });
}
