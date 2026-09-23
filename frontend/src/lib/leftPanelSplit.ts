export type LeftPanelDropZone = 'top' | 'bottom' | 'left' | 'right';
export type LeftSplitDirection = 'above' | 'below' | 'left' | 'right';

export const MIN_WIDTH_FOR_SIDE_SPLIT = 360;
export const DEFAULT_STACK_RATIO = 0.62;
export const DEFAULT_ROW_RATIO = 0.5;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (box.width < 1 || box.height < 1) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boxContains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

export function resolveLeftPanelDropZone(
  point: Point,
  box: Box,
  allowSideSplit = box.width >= MIN_WIDTH_FOR_SIDE_SPLIT
): LeftPanelDropZone | null {
  if (box.width < 1 || box.height < 1 || !boxContains(box, point)) {
    return null;
  }

  const relY = (point.y - box.y) / box.height;
  if (!allowSideSplit) {
    return relY < 0.5 ? 'top' : 'bottom';
  }

  if (relY < 1 / 3) return 'top';
  if (relY > 2 / 3) return 'bottom';
  const relX = (point.x - box.x) / box.width;
  return relX < 0.5 ? 'left' : 'right';
}

export function ghostBoxForZone(box: Box, zone: LeftPanelDropZone): Box {
  switch (zone) {
    case 'top':
      return { x: box.x, y: box.y, width: box.width, height: box.height / 2 };
    case 'bottom':
      return {
        x: box.x,
        y: box.y + box.height / 2,
        width: box.width,
        height: box.height / 2,
      };
    case 'left':
      return { x: box.x, y: box.y, width: box.width / 2, height: box.height };
    case 'right':
      return {
        x: box.x + box.width / 2,
        y: box.y,
        width: box.width / 2,
        height: box.height,
      };
  }
}

export function dropZoneToDirection(zone: LeftPanelDropZone): LeftSplitDirection {
  switch (zone) {
    case 'top':
      return 'above';
    case 'bottom':
      return 'below';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
  }
}

export function isRowSplit(zone: LeftPanelDropZone): boolean {
  return zone === 'left' || zone === 'right';
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_STACK_RATIO;
  return Math.min(0.8, Math.max(0.2, ratio));
}

export function sizesFromRatio(
  total: number,
  ratio: number,
  minPane: number
): { first: number; second: number } {
  if (total < minPane * 2) {
    const half = total / 2;
    return { first: half, second: total - half };
  }
  const first = Math.round(total * clampRatio(ratio));
  const bounded = Math.min(total - minPane, Math.max(minPane, first));
  return { first: bounded, second: total - bounded };
}

export function ratioFromSizes(first: number, total: number): number {
  if (total <= 0) return DEFAULT_ROW_RATIO;
  return clampRatio(first / total);
}

/**
 * When the outer left-column size changes, keep the inner split proportional.
 * A 50/50 split therefore moves the divider by half the outer delta.
 */
export function innerSizeAfterOuterResize(
  previousOuter: number,
  nextOuter: number,
  previousFirst: number
): number {
  if (nextOuter <= 0) return 0;
  if (previousOuter <= 0) return nextOuter / 2;
  return (previousFirst / previousOuter) * nextOuter;
}

export function classifyLeftDockSplit(
  boxes: readonly Box[]
): 'single' | 'stack' | 'row' {
  if (boxes.length < 2) return 'single';
  const first = boxes[0];
  const stacked = boxes.every(
    (box) => Math.abs(box.x - first.x) <= 2 && Math.abs(box.width - first.width) <= 2
  );
  if (stacked) return 'stack';
  const row = boxes.every(
    (box) => Math.abs(box.y - first.y) <= 2 && Math.abs(box.height - first.height) <= 2
  );
  if (row) return 'row';
  return 'stack';
}

export function sortBoxesForSplit(
  boxes: readonly Box[],
  split: 'stack' | 'row'
): Box[] {
  return boxes.slice().sort((a, b) =>
    split === 'stack' ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y
  );
}
