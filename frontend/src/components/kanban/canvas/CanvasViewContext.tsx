import { createContext, useContext } from 'react';

import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import type { CanvasNodeGeometry } from './canvasModel';

export interface SessionCanvasViewContextValue {
  sessionsById: ReadonlyMap<string, KanbanProjectSessionRecord>;
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
  resizeGroup: (groupId: string, geometry: CanvasNodeGeometry) => void;
  collapseGroup: (groupId: string) => void;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
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
