import type { SessionCanvasNode } from './canvasModel';

export const CANVAS_HISTORY_LIMIT = 50;

export function snapshotCanvasNodes(
  nodes: readonly SessionCanvasNode[]
): SessionCanvasNode[] {
  return nodes.map((node) => ({ ...node }));
}

export function canvasNodesMatch(
  left: readonly SessionCanvasNode[],
  right: readonly SessionCanvasNode[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((node, index) => {
    const other = right[index];
    return (
      node.id === other.id &&
      node.kind === other.kind &&
      node.sessionId === other.sessionId &&
      node.parentId === other.parentId &&
      node.name === other.name &&
      node.x === other.x &&
      node.y === other.y &&
      node.width === other.width &&
      node.height === other.height &&
      node.expanded === other.expanded &&
      node.collapsed === other.collapsed &&
      node.openedFromId === other.openedFromId
    );
  });
}
