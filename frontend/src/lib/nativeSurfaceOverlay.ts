export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OVERLAY_HIT_PADDING = 8;

function withPadding(rect: OverlayRect): OverlayRect {
  return {
    x: rect.x - OVERLAY_HIT_PADDING,
    y: rect.y - OVERLAY_HIT_PADDING,
    width: rect.width + OVERLAY_HIT_PADDING * 2,
    height: rect.height + OVERLAY_HIT_PADDING * 2,
  };
}

function intersects(surface: OverlayRect, overlay: OverlayRect): boolean {
  return !(
    overlay.x + overlay.width <= surface.x ||
    overlay.x >= surface.x + surface.width ||
    overlay.y + overlay.height <= surface.y ||
    overlay.y >= surface.y + surface.height
  );
}

/** True when an HTML popover sits over the native browser page. */
export function overlayCoversSurface(
  surface: OverlayRect,
  overlays: readonly OverlayRect[]
): boolean {
  return overlays.some((overlay) => intersects(surface, withPadding(overlay)));
}

/**
 * Freeze-then-hide is only for HTML layers that need a still of the page
 * underneath. Full chrome occlusion (kanban / workspace tab switch) must
 * drop the native HWND in the same frame, or the live page sits on top of
 * the next surface until CapturePreview finishes.
 */
export function nativeSurfaceNeedsFreezeFrame(occlusion: {
  hide: boolean;
}): boolean {
  return !occlusion.hide;
}
