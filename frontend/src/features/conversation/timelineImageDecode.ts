/** Decoded timeline images, capped per panel. Bytes stay out of the row. */

export const MAX_DECODED_TIMELINE_IMAGES = 2;
const VIBEX_IMAGE_PREFIX = 'vibex-image:';

type Slot = { url: string; owned: boolean };

const panels = new Map<string, Map<string, Slot>>();
const listeners = new Set<() => void>();

export function timelineImageHash(
  uri: string | null | undefined
): string | null {
  if (!uri?.startsWith(VIBEX_IMAGE_PREFIX)) return null;
  const hash = uri.slice(VIBEX_IMAGE_PREFIX.length).toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

export function timelineImageSrc(panelId: string, key: string): string | null {
  return panels.get(panelId)?.get(key)?.url ?? null;
}

export function claimTimelineImage(
  panelId: string,
  key: string,
  url: string,
  owned: boolean
): void {
  const panel = panels.get(panelId) ?? new Map<string, Slot>();
  panels.set(panelId, panel);
  const existing = panel.get(key);
  if (existing) {
    panel.delete(key);
    if (existing.url !== url && existing.owned) revokeUrl(existing.url);
  }
  panel.set(key, { url, owned });
  while (panel.size > MAX_DECODED_TIMELINE_IMAGES) {
    const oldest = panel.keys().next().value;
    if (oldest === undefined) break;
    const evicted = panel.get(oldest);
    panel.delete(oldest);
    if (evicted?.owned) revokeUrl(evicted.url);
  }
  notify();
}

export function releaseTimelineImage(panelId: string, key: string): void {
  const panel = panels.get(panelId);
  const slot = panel?.get(key);
  if (!panel || !slot) return;
  panel.delete(key);
  if (panel.size === 0) panels.delete(panelId);
  if (slot.owned) revokeUrl(slot.url);
  notify();
}

export function releaseTimelineImagePanel(panelId: string): void {
  const panel = panels.get(panelId);
  if (!panel) return;
  for (const slot of panel.values()) {
    if (slot.owned) revokeUrl(slot.url);
  }
  panels.delete(panelId);
  notify();
}

export function subscribeTimelineImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetTimelineImagesForTests(): void {
  for (const panelId of [...panels.keys()]) {
    releaseTimelineImagePanel(panelId);
  }
  listeners.clear();
}

export function objectUrlForBytes(bytes: Uint8Array, mimeType: string): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const payload = Uint8Array.from(bytes);
    return URL.createObjectURL(new Blob([payload], { type: mimeType }));
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function revokeUrl(url: string): void {
  if (
    url.startsWith('blob:') &&
    typeof URL !== 'undefined' &&
    typeof URL.revokeObjectURL === 'function'
  ) {
    URL.revokeObjectURL(url);
  }
}
