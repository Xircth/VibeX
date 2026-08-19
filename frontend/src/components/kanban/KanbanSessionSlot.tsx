import { useCallback, useEffect, useRef } from 'react';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useRightPanelSlot } from '@/contexts/RightPanelSlotContext';
import {
  kanbanSessionResizeHandleSide,
  useKanbanArrangement,
} from '@/lib/layoutArrangement';
import { kanbanSessionFillsHub } from '@/lib/kanbanZoneVisibility';
import { cn } from '@/lib/utils';

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
  const arrangement = useKanbanArrangement();
  const handleSide = kanbanSessionResizeHandleSide(arrangement);
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const isKanbanMonitorVisible = useLayoutStore(
    (state) => state.isKanbanMonitorVisible
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

  const fill = kanbanSessionFillsHub(side === 'center', {
    list: true,
    monitor: isKanbanMonitorVisible,
    session: isKanbanSessionVisible,
  });
  const shouldShow = isKanbanSessionVisible && !!host && active;
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
          const delta =
            handleSide === 'right'
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
    [handleSide, kanbanSessionWidth, setKanbanSessionWidth]
  );

  if (!shouldShow) return null;

  const handle = fill ? null : (
    <div
      role="separator"
      aria-orientation="vertical"
      data-handle-side={handleSide}
      className="workspace-resize-handle relative z-20 w-px shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:-left-[5px] after:w-[11px] after:content-['']"
      onMouseDown={handleResizeMouseDown}
    />
  );

  return (
    <div
      className={cn('flex h-full', fill ? 'min-w-0 flex-1' : 'shrink-0')}
      data-panel="kanban-session-slot"
      data-slot-side={side}
    >
      {handleSide === 'left' && handle}
      <div
        ref={containerRef}
        className="workspace-right-panel h-full min-w-0 overflow-hidden"
        style={{ width: fill ? '100%' : kanbanSessionWidth }}
      />
      {handleSide === 'right' && handle}
    </div>
  );
}
