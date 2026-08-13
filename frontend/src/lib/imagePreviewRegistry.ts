export const IMAGE_PREVIEW_PANEL_ID_PREFIX = 'image:';

const imagePreviewSources = new Map<string, string>();

export function isImagePreviewPanelId(panelId: string): boolean {
  return panelId.startsWith(IMAGE_PREVIEW_PANEL_ID_PREFIX);
}

export function registerImagePreviewSource(
  panelId: string,
  imageUrl: string
): void {
  imagePreviewSources.set(panelId, imageUrl);
}

export function resolveImagePreviewSource(panelId: string): string | null {
  return imagePreviewSources.get(panelId) ?? null;
}

export function releaseImagePreviewSource(panelId: string): void {
  imagePreviewSources.delete(panelId);
}

export function clearImagePreviewSources(): void {
  imagePreviewSources.clear();
}
