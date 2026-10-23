import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
} from '@dnd-kit/core';

/**
 * Status columns stack vertically. The last column is often the tallest, so
 * its center sits far below a pointer that is over the column's header.
 * `closestCenter` then highlights the column above. A pointer inside a column
 * always selects that column. Canvas drops do not fall back to a distant
 * column when the pointer is over the board.
 */
export function sessionHubDropCollision(
  args: Parameters<CollisionDetection>[0],
  options: { canvasDrop: boolean }
): ReturnType<CollisionDetection> {
  const hovered = pointerWithin(args);
  if (hovered.length > 0) {
    return hovered;
  }
  if (options.canvasDrop) {
    return [];
  }
  return closestCenter(args);
}
