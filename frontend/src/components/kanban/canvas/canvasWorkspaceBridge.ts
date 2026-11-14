export interface OpenCanvasPanelRequest {
  id: string;
  component: string;
  title: string;
  params?: Record<string, unknown>;
  expanded?: boolean;
  parentNodeId?: string | null;
  position?: { x: number; y: number };
}

export interface OpenCanvasSessionRequest {
  sessionId: string;
  expanded?: boolean;
  parentNodeId?: string | null;
  position?: { x: number; y: number };
}

export interface CanvasWorkspaceController {
  createSession?: () => void;
  openOrFocusPanel: (request: OpenCanvasPanelRequest) => string;
  openOrFocusSession: (request: OpenCanvasSessionRequest) => string;
  dropSessionAt: (
    sessionId: string,
    client: { x: number; y: number },
    cardWidth?: number | null
  ) => void;
  dropPanelAt: (
    request: OpenCanvasPanelRequest,
    client: { x: number; y: number }
  ) => string;
  closeNode: (instanceId: string) => void;
  closeOtherNodes: (instanceId: string) => void;
  closeAllNodes: () => void;
  duplicateNode: (instanceId: string) => string | null;
}

const registeredControllers: CanvasWorkspaceController[] = [];
let scopedParentNodeId: string | null = null;
let pendingParentNode: { nodeId: string; expiresAt: number } | null = null;

const PENDING_PARENT_TTL_MS = 8_000;

export function registerCanvasWorkspaceController(
  controller: CanvasWorkspaceController | null
): () => void {
  if (!controller) {
    registeredControllers.length = 0;
    return () => undefined;
  }
  const existingIndex = registeredControllers.indexOf(controller);
  if (existingIndex !== -1) {
    registeredControllers.splice(existingIndex, 1);
  }
  registeredControllers.push(controller);
  return () => {
    const idx = registeredControllers.indexOf(controller);
    if (idx !== -1) {
      registeredControllers.splice(idx, 1);
    }
  };
}

export function getCanvasWorkspaceController(): CanvasWorkspaceController | null {
  return registeredControllers.length > 0
    ? (registeredControllers[registeredControllers.length - 1] ?? null)
    : null;
}

export function setPendingCanvasParentNode(
  nodeId: string | null,
  ttlMs = PENDING_PARENT_TTL_MS
): void {
  if (!nodeId) {
    pendingParentNode = null;
    return;
  }
  pendingParentNode = {
    nodeId,
    expiresAt: Date.now() + ttlMs,
  };
}

export function consumeCanvasParentNodeId(
  explicitParentId?: string | null
): string | null {
  if (explicitParentId) {
    pendingParentNode = null;
    return explicitParentId;
  }
  if (scopedParentNodeId) {
    pendingParentNode = null;
    return scopedParentNodeId;
  }
  if (pendingParentNode) {
    const { nodeId, expiresAt } = pendingParentNode;
    pendingParentNode = null;
    if (Date.now() <= expiresAt) {
      return nodeId;
    }
  }
  return null;
}

export function peekCanvasParentNodeId(): string | null {
  if (scopedParentNodeId) return scopedParentNodeId;
  if (pendingParentNode && Date.now() <= pendingParentNode.expiresAt) {
    return pendingParentNode.nodeId;
  }
  return null;
}

export function runWithCanvasParentNode<T>(
  nodeId: string | null,
  fn: () => T
): T {
  const previous = scopedParentNodeId;
  scopedParentNodeId = nodeId;
  if (nodeId) {
    setPendingCanvasParentNode(nodeId);
  }
  try {
    return fn();
  } finally {
    scopedParentNodeId = previous;
  }
}
