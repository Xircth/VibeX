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
export const ACCENT_HSL_VAR = '--accent-hsl';
export const ACCENT_FOREGROUND_HSL_VAR = '--accent-foreground-hsl';

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

export function applyAccentColor(hex: string): void {
  const color = parseAccentColor(hex);
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
