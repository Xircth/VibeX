export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const SCALE_STEP = 0.25;

export type Size = {
  width: number;
  height: number;
};

export type Offset = {
  x: number;
  y: number;
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getContainedSize(natural: Size, viewport: Size) {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0, fitRatio: 1 };
  }

  const fitRatio = Math.min(
    viewport.width / natural.width,
    viewport.height / natural.height,
    1
  );

  return {
    width: natural.width * fitRatio,
    height: natural.height * fitRatio,
    fitRatio,
  };
}

export function clampOffset(
  offset: Offset,
  scale: number,
  fitted: Size,
  viewport: Size
) {
  const scaledWidth = fitted.width * scale;
  const scaledHeight = fitted.height * scale;
  const maxOffsetX = Math.max(0, (scaledWidth - viewport.width) / 2);
  const maxOffsetY = Math.max(0, (scaledHeight - viewport.height) / 2);

  return {
    x: maxOffsetX === 0 ? 0 : clamp(offset.x, -maxOffsetX, maxOffsetX),
    y: maxOffsetY === 0 ? 0 : clamp(offset.y, -maxOffsetY, maxOffsetY),
  };
}

export function canPanImage(scale: number, fitted: Size, viewport: Size) {
  return (
    fitted.width * scale > viewport.width ||
    fitted.height * scale > viewport.height
  );
}

export function actualSizeScale(fitRatio: number) {
  if (fitRatio <= 0) {
    return MIN_SCALE;
  }

  return Math.max(MIN_SCALE, 1 / fitRatio);
}

export function offsetAfterScale({
  currentOffset,
  currentScale,
  nextScale,
  anchor,
  fitted,
  viewport,
}: {
  currentOffset: Offset;
  currentScale: number;
  nextScale: number;
  anchor: Offset;
  fitted: Size;
  viewport: Size;
}): Offset {
  const safeScale = currentScale <= 0 ? MIN_SCALE : currentScale;
  return clampOffset(
    {
      x: anchor.x - ((anchor.x - currentOffset.x) / safeScale) * nextScale,
      y: anchor.y - ((anchor.y - currentOffset.y) / safeScale) * nextScale,
    },
    nextScale,
    fitted,
    viewport
  );
}

export function applyViewScale({
  currentOffset,
  currentScale,
  nextScale,
  fitted,
  viewport,
  anchor,
}: {
  currentOffset: Offset;
  currentScale: number;
  nextScale: number;
  fitted: Size;
  viewport: Size;
  anchor?: Offset;
}): { scale: number; offset: Offset } {
  const normalizedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);

  if (
    normalizedScale === MIN_SCALE ||
    fitted.width === 0 ||
    fitted.height === 0
  ) {
    return { scale: MIN_SCALE, offset: { x: 0, y: 0 } };
  }

  if (!anchor) {
    return {
      scale: normalizedScale,
      offset: clampOffset(currentOffset, normalizedScale, fitted, viewport),
    };
  }

  return {
    scale: normalizedScale,
    offset: offsetAfterScale({
      currentOffset,
      currentScale,
      nextScale: normalizedScale,
      anchor,
      fitted,
      viewport,
    }),
  };
}
