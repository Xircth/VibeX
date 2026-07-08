import { useCallback, useEffect, useRef } from 'react';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useRightPanelSlot } from '@/contexts/RightPanelSlotContext';

interface KanbanSessionSlotProps {
  /** Which kanban slot this instance renders in. */
  side: 'left' | 'center' | 'right';
  /**
   * Whether this instance currently owns the session content. Only one slot
   * may be active at a time (e.g. the in-hub center slot on the session-hub
   * view, the outer edge slot on the other views).
   */
  active: boolean;
}

/**
 * Session (C zone) slot on the kanban page. Adopts the shared session host
 * element while the kanban page owns the placement, so the conversation
 * keeps its React state when moving between the workspace dockview panel
 * and this slot.
 */
export function KanbanSessionSlot({ side, active }: KanbanSessionSlotProps) {
  const { host, placement } = useRightPanelSlot();
  const isRightPanelVisible = useLayoutStore(
    (state) => state.isRightPanelVisible
  );
  // The kanban page has its own session width memory; it shares only the
  // DEFAULT with the workspace C zone (whose live width may be a flexible
  // center-slot remainder and is not a meaningful column width here).
  const kanbanSessionWidth = useLayoutStore(
    (state) => state.kanbanSessionWidth
  );
  const setKanbanSessionWidth = useLayoutStore(
    (state) => state.setKanbanSessionWidth
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeAbortRef = useRef<AbortController | null>(null);

  const shouldShow = isRightPanelVisible && !!host && active;
  const ownsHost = shouldShow && placement === 'kanban';

  useEffect(() => {
    if (!ownsHost || !host) return;

    const container = containerRef.current;
    if (!container) return;

    container.appendChild(host);
    return () => {
      if (host.parentElement === container) {
        container.removeChild(host);
      }
    };
  }, [host, ownsHost]);

  useEffect(() => () => resizeAbortRef.current?.abort(), []);

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = kanbanSessionWidth;

      resizeAbortRef.current?.abort();
      const controller = new AbortController();
      resizeAbortRef.current = controller;
      const { signal } = controller;

      document.addEventListener(
        'mousemove',
        (moveEvent) => {
          // The handle sits on the board-facing edge: right edge when the
          // slot is at the left, left edge otherwise.
          const delta =
            side === 'left'
              ? moveEvent.clientX - startX
              : startX - moveEvent.clientX;
          setKanbanSessionWidth(startWidth + delta);
        },
        { signal }
      );
      document.addEventListener(
        'mouseup',
        () => {
          resizeAbortRef.current?.abort();
          resizeAbortRef.current = null;
        },
        { signal }
      );
    },
    [kanbanSessionWidth, setKanbanSessionWidth, side]
  );

  if (!shouldShow) return null;

  const handle = (
    <div
      className="workspace-resize-handle relative z-20 w-px shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:-left-[5px] after:w-[11px] after:content-['']"
      onMouseDown={handleResizeMouseDown}
    />
  );

  return (
    <div className="flex h-full shrink-0" data-panel="kanban-session-slot">
      {side !== 'left' && handle}
      <div
        ref={containerRef}
        className="workspace-right-panel h-full min-w-0 overflow-hidden"
        style={{ width: kanbanSessionWidth }}
      />
      {side === 'left' && handle}
    </div>
  );
}
