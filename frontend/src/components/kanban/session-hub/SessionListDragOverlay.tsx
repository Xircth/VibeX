import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DragOverlay } from '@dnd-kit/core';
import {
  SESSION_LIST_DRAG_OVERLAY_CLASS,
  snapDragOverlayToCursor,
} from './sessionListDrag';

interface SessionListDragOverlayProps {
  children: ReactNode;
}

export function SessionListDragOverlay({
  children,
}: SessionListDragOverlayProps) {
  const overlay = (
    <DragOverlay
      className={`${SESSION_LIST_DRAG_OVERLAY_CLASS} pointer-events-none`}
      style={{ pointerEvents: 'none' }}
      dropAnimation={null}
      modifiers={[snapDragOverlayToCursor]}
      zIndex={2000}
    >
      {children}
    </DragOverlay>
  );

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
}
