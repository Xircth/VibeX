import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

/**
 * UI zoom (P3): a frontend-only, localStorage-persisted scale applied to the
 * document root so the whole app can be zoomed for readability. Uses the CSS
 * `zoom` property (supported by the Tauri webview) which scales layout
 * uniformly.
 */
const ZOOM_KEY = 'vibex:ui-zoom';
export const UI_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25] as const;
const DEFAULT_ZOOM = 1;

export function getUiZoom(): number {
  const raw = Number(readLocalStorage(ZOOM_KEY));
  return UI_ZOOM_LEVELS.includes(raw as (typeof UI_ZOOM_LEVELS)[number])
    ? raw
    : DEFAULT_ZOOM;
}

export function applyUiZoom(scale: number): void {
  // `zoom` isn't in the typed CSSStyleDeclaration; assign via setProperty.
  document.documentElement.style.setProperty('zoom', String(scale));
}

export function setUiZoom(scale: number): void {
  writeLocalStorage(ZOOM_KEY, String(scale));
  persistFrontendPreference(ZOOM_KEY, scale);
  applyUiZoom(scale);
}

/** Apply the persisted zoom on startup. */
export function initUiZoom(): void {
  applyUiZoom(getUiZoom());
}
