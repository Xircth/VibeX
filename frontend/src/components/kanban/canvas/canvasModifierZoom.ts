export type CanvasZoomViewport = { x: number; y: number; zoom: number };

/**
 * Ctrl/Cmd + wheel, including the trackpad pinch that browsers report as
 * a ctrl-modified wheel event. Plain wheel stays a pan or an in-node scroll.
 */
export function isCanvasModifierZoomWheel(event: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * Same wheel delta React Flow uses, so zoom speed on empty canvas stays put.
 * Pinch on macOS is reported with ctrlKey and a 10x smaller delta.
 */
export function nextCanvasModifierZoom(input: {
  viewport: CanvasZoomViewport;
  pointerX: number;
  pointerY: number;
  deltaY: number;
  deltaMode: number;
  pinchBoost: boolean;
  minZoom: number;
  maxZoom: number;
}): CanvasZoomViewport {
  const modeScale =
    input.deltaMode === 1 ? 0.05 : input.deltaMode ? 1 : 0.002;
  const wheelDelta =
    -input.deltaY * modeScale * (input.pinchBoost ? 10 : 1);
  const zoom = clamp(
    input.viewport.zoom * Math.pow(2, wheelDelta),
    input.minZoom,
    input.maxZoom
  );
  if (zoom === input.viewport.zoom) return input.viewport;
  const ratio = zoom / input.viewport.zoom;
  return {
    x: input.pointerX - (input.pointerX - input.viewport.x) * ratio,
    y: input.pointerY - (input.pointerY - input.viewport.y) * ratio,
    zoom,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
