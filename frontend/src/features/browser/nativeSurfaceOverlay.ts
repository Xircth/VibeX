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

/** True when an HTML popover sits over the native CEF page. */
export function overlayCoversSurface(
  surface: OverlayRect,
  overlays: readonly OverlayRect[]
): boolean {
  return overlays.some((overlay) => intersects(surface, withPadding(overlay)));
}
