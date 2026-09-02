import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

/**
 * UI zoom (P3): a frontend-only, localStorage-persisted scale for readability.
 *
 * CSS `zoom` on `html` is intentionally not used. It puts `getBoundingClientRect`
 * and `position: fixed` / CSS anchor positioning into different coordinate
 * spaces, so popovers and selects collapse to the viewport origin.
 *
 * Desktop uses the webview's native page zoom (same CSS-pixel space for layout
 * and overlays). Other runtimes scale the rem root instead.
 */
export const UI_ZOOM_KEY = 'vibex:ui-zoom';
export const UI_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25] as const;
const DEFAULT_ZOOM = 1;

let nativeZoomGeneration = 0;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function applyCssFontScale(scale: number): void {
  if (scale === DEFAULT_ZOOM) {
    document.documentElement.style.removeProperty('font-size');
    return;
  }
  document.documentElement.style.fontSize = `${scale * 100}%`;
}

async function applyNativeWebviewZoom(
  scale: number,
  generation: number
): Promise<void> {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    if (generation !== nativeZoomGeneration) return;
    await getCurrentWebview().setZoom(scale);
  } catch {
    if (generation !== nativeZoomGeneration) return;
    applyCssFontScale(scale);
  }
}

export function getUiZoom(): number {
  const raw = Number(readLocalStorage(UI_ZOOM_KEY));
  return UI_ZOOM_LEVELS.includes(raw as (typeof UI_ZOOM_LEVELS)[number])
    ? raw
    : DEFAULT_ZOOM;
}

export function applyUiZoom(scale: number): void {
  const root = document.documentElement;
  root.style.removeProperty('zoom');
  root.style.setProperty('--ui-zoom', String(scale));

  const generation = ++nativeZoomGeneration;
  if (isTauriRuntime()) {
    root.style.removeProperty('font-size');
    void applyNativeWebviewZoom(scale, generation);
    return;
  }

  applyCssFontScale(scale);
}

export function setUiZoom(scale: number): void {
  writeLocalStorage(UI_ZOOM_KEY, String(scale));
  persistFrontendPreference(UI_ZOOM_KEY, scale);
  applyUiZoom(scale);
}

/** Apply the persisted zoom on startup. */
export function initUiZoom(): void {
  applyUiZoom(getUiZoom());
}
