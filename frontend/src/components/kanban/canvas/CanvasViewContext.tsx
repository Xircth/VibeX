import { createContext, useContext, useSyncExternalStore } from 'react';

import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import type { CanvasHandleSide, CanvasNodeGeometry } from './canvasModel';
import type { CanvasSessionStore } from './canvasSessionStore';
import type {
  OpenCanvasPanelRequest,
  OpenCanvasSessionRequest,
} from './canvasWorkspaceBridge';

export interface SessionCanvasViewContextValue {
  sessionStore?: CanvasSessionStore;
  sessionsById?: ReadonlyMap<string, KanbanProjectSessionRecord>;
  sessionsReady: boolean;
  expandCard: (sessionId: string) => void;
  collapseCard: (sessionId: string) => void;
  removeCard: (sessionId: string) => void;
  zoomToCard: (sessionId: string) => void;
  previewResize: (sessionId: string, geometry: CanvasNodeGeometry) => void;
  resizeCard: (sessionId: string, geometry: CanvasNodeGeometry) => void;
  resetCardSize: (sessionId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  toggleGroupShowAll: (groupId: string) => void;
  previewGroupResize: (groupId: string, geometry: CanvasNodeGeometry) => void;
  beginGroupResize: (groupId: string) => void;
  resizeGroup: (groupId: string, geometry: CanvasNodeGeometry) => void;
  collapseGroup: (groupId: string) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onArchiveSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  beginHandleConnect?: (
    sourceId: string,
    sourceHandle: CanvasHandleSide,
    clientX: number,
    clientY: number
  ) => void;
  completeHandleConnect?: (
    targetId: string,
    targetHandle: CanvasHandleSide
  ) => void;
  hoverHandleTarget?: (
    targetId: string | null,
    targetHandle: CanvasHandleSide | null
  ) => void;
  isConnectingLink?: boolean;
  openOrFocusPanelNode?: (request: OpenCanvasPanelRequest) => string;
  openOrFocusSessionNode?: (request: OpenCanvasSessionRequest) => string;
  duplicateCanvasNode?: (instanceId: string) => string | null;
  closeOtherCanvasNodes?: (instanceId: string) => void;
  sortCanvasNodes?: () => void;
  onCreateSessionWithExecutor?: (executor: string, parentNodeId?: string) => void;
  onNewSession?: (parentNodeId?: string) => void;
  updatePanelNodeMeta?: (
    instanceId: string,
    patch: { title?: string; params?: Record<string, unknown> }
  ) => void;
}

const SessionCanvasViewContext =
  createContext<SessionCanvasViewContextValue | null>(null);

export const SessionCanvasViewProvider = SessionCanvasViewContext.Provider;

export function useSessionCanvasView(): SessionCanvasViewContextValue {
  const value = useContext(SessionCanvasViewContext);
  if (!value) {
    throw new Error('useSessionCanvasView must be used inside the canvas');
  }
  return value;
}

export function useCanvasSession(
  sessionId: string
): KanbanProjectSessionRecord | undefined {
  const { sessionStore, sessionsById } = useSessionCanvasView();
  return useSyncExternalStore(
    (onChange) =>
      sessionStore ? sessionStore.subscribe(sessionId, onChange) : () => {},
    () => sessionStore?.get(sessionId) ?? sessionsById?.get(sessionId),
    () => sessionStore?.get(sessionId) ?? sessionsById?.get(sessionId)
  );
}
