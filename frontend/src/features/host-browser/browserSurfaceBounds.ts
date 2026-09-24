export type BrowserSurfaceRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Snap a CSS rect onto the device pixel grid by rounding each edge, then
 * deriving size from those edges. Independent rounding of `x` and `width`
 * can make the native child one physical pixel wider than the HTML host,
 * which covers the dock sash while the freeze-frame (clipped to the host)
 * does not.
 */
export function snapBrowserSurfaceRect(
  rect: BrowserSurfaceRect,
  scale: number
): { x: number; y: number; width: number; height: number } {
  const s = scale > 0 ? scale : 1;
  const x = Math.round(rect.left * s) / s;
  const y = Math.round(rect.top * s) / s;
  const right = Math.round(rect.right * s) / s;
  const bottom = Math.round(rect.bottom * s) / s;
  return {
    x,
    y,
    width: Math.max(1 / s, right - x),
    height: Math.max(1 / s, bottom - y),
  };
}
