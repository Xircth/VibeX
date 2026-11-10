import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  ACTIVITY_RAIL_PANEL_TITLES,
  type ActivityRailItemId,
} from '@/lib/activityRailOrder';
import type { ShellNavDropTarget } from '@/lib/leftDockPlacement';
import { resolveLeftPanelDropZone, type Point } from '@/lib/leftPanelSplit';
import { cn } from '@/lib/utils';

const DRAG_ACTIVATION_DISTANCE = 5;

export function ShellNavPanelDragHandle({
  panelId,
  className,
}: {
  panelId: ActivityRailItemId;
  className?: string;
}) {
  const { t } = useTranslation('panels');
  const { placeLeftDockPanel, resolveShellNavDropTarget, measureLeftDock } =
    usePanelActionsContext();
  const [dragging, setDragging] = useState(false);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [target, setTarget] = useState<ShellNavDropTarget | null>(null);
  const startPointRef = useRef<Point | null>(null);
  const draggingRef = useRef(false);
  const targetRef = useRef<ShellNavDropTarget | null>(null);

  useEffect(() => {
    if (!dragging && !startPointRef.current) return;

    const handlePointerMove = (event: PointerEvent) => {
      const start = startPointRef.current;
      if (!start) return;

      const current: Point = { x: event.clientX, y: event.clientY };
      if (!draggingRef.current) {
        const dx = current.x - start.x;
        const dy = current.y - start.y;
        if (Math.hypot(dx, dy) < DRAG_ACTIVATION_DISTANCE) return;
        draggingRef.current = true;
        setDragging(true);
      }

      setPointer(current);
      let resolved = resolveShellNavDropTarget(current, panelId);
      if (!resolved) {
        const fallbackBox = measureLeftDock();
        const zone = fallbackBox
          ? resolveLeftPanelDropZone(current, fallbackBox)
          : null;
        if (fallbackBox && zone) {
          resolved = {
            side: 'left',
            zone,
            containerBox: fallbackBox,
            ghostBox:
              zone === 'top'
                ? {
                    x: fallbackBox.x,
                    y: fallbackBox.y,
                    width: fallbackBox.width,
                    height: fallbackBox.height / 2,
                  }
                : zone === 'bottom'
                  ? {
                      x: fallbackBox.x,
                      y: fallbackBox.y + fallbackBox.height / 2,
                      width: fallbackBox.width,
                      height: fallbackBox.height / 2,
                    }
                  : zone === 'left'
                    ? {
                        x: fallbackBox.x,
                        y: fallbackBox.y,
                        width: fallbackBox.width / 2,
                        height: fallbackBox.height,
                      }
                    : {
                        x: fallbackBox.x + fallbackBox.width / 2,
                        y: fallbackBox.y,
                        width: fallbackBox.width / 2,
                        height: fallbackBox.height,
                      },
          };
        }
      }
      targetRef.current = resolved;
      setTarget(resolved);
    };

    const finishDrag = (commit: boolean) => {
      const finalTarget = targetRef.current;
      const wasDragging = draggingRef.current;
      startPointRef.current = null;
      draggingRef.current = false;
      targetRef.current = null;
      setDragging(false);
      setPointer(null);
      setTarget(null);

      if (commit && wasDragging && finalTarget) {
        if (finalTarget.side === 'right' || finalTarget.targetPanelId) {
          placeLeftDockPanel(panelId, finalTarget.zone, {
            side: finalTarget.side,
            targetPanelId: finalTarget.targetPanelId,
          });
        } else {
          placeLeftDockPanel(panelId, finalTarget.zone);
        }
      }
    };

    const handlePointerUp = () => finishDrag(true);
    const handlePointerCancel = () => finishDrag(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finishDrag(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    dragging,
    measureLeftDock,
    panelId,
    placeLeftDockPanel,
    resolveShellNavDropTarget,
  ]);

  const title = t(
    'ideLayout.dragPanelHandle',
    '按住拖拽面板换位，或拖至页面右侧'
  );
  const panelTitle = ACTIVITY_RAIL_PANEL_TITLES[panelId] ?? panelId;

  return (
    <>
      <button
        type="button"
        data-testid={`shell-nav-drag-handle-${panelId}`}
        aria-label={title}
        title={title}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          startPointRef.current = { x: event.clientX, y: event.clientY };
          setPointer({ x: event.clientX, y: event.clientY });
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className={cn(
          'shell-nav-panel-drag-handle inline-flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-low transition-colors hover:bg-secondary/60 hover:text-high active:cursor-grabbing',
          dragging && 'bg-secondary/80 text-high',
          className
        )}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {dragging && target && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="left-panel-split-overlay"
              style={{
                top: target.containerBox.y,
                left: target.containerBox.x,
                width: target.containerBox.width,
                height: target.containerBox.height,
              }}
            >
              <div
                className="left-panel-split-ghost"
                style={{
                  top: target.ghostBox.y - target.containerBox.y,
                  left: target.ghostBox.x - target.containerBox.x,
                  width: target.ghostBox.width,
                  height: target.ghostBox.height,
                }}
              />
            </div>,
            document.body
          )
        : null}
      {dragging && pointer && typeof document !== 'undefined'
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[9999] flex items-center gap-1.5 rounded border border-border bg-secondary px-2 py-1 text-xs font-medium text-high shadow-md"
              style={{
                left: pointer.x + 12,
                top: pointer.y + 12,
              }}
            >
              <GripVertical className="h-3 w-3 text-low" />
              <span>{panelTitle}</span>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
