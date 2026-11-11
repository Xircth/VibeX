import { memo, type MouseEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { CANVAS_HANDLE_SIDES, type CanvasHandleSide } from './canvasModel';
import { useSessionCanvasView } from './CanvasViewContext';

const HANDLE_POSITION_CLASSES: Record<CanvasHandleSide, string> = {
  top: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
  right: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2',
  bottom: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2',
  left: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
};

const HANDLE_LABELS: Record<CanvasHandleSide, string> = {
  top: '上方连接点',
  right: '右侧连接点',
  bottom: '下方连接点',
  left: '左侧连接点',
};

export const CanvasNodeHandles = memo(function CanvasNodeHandles({
  instanceId,
}: {
  instanceId: string;
}) {
  const {
    beginHandleConnect,
    completeHandleConnect,
    hoverHandleTarget,
    isConnectingLink,
  } = useSessionCanvasView();

  const handleStart = (
    side: CanvasHandleSide,
    event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    beginHandleConnect?.(instanceId, side, event.clientX, event.clientY);
  };

  const handleEnd = (
    side: CanvasHandleSide,
    event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>
  ) => {
    if (!isConnectingLink) return;
    event.stopPropagation();
    event.preventDefault();
    completeHandleConnect?.(instanceId, side);
  };

  return (
    <>
      {CANVAS_HANDLE_SIDES.map((side) => (
        <button
          key={side}
          type="button"
          aria-label={HANDLE_LABELS[side]}
          data-testid={`canvas-node-handle-${instanceId}-${side}`}
          data-canvas-handle-node-id={instanceId}
          data-canvas-handle-side={side}
          onPointerDown={(event) => handleStart(side, event)}
          onMouseDown={(event) => handleStart(side, event)}
          onPointerUp={(event) => handleEnd(side, event)}
          onMouseUp={(event) => handleEnd(side, event)}
          onPointerEnter={() => {
            if (isConnectingLink) {
              hoverHandleTarget?.(instanceId, side);
            }
          }}
          onMouseEnter={() => {
            if (isConnectingLink) {
              hoverHandleTarget?.(instanceId, side);
            }
          }}
          onPointerLeave={() => {
            if (isConnectingLink) {
              hoverHandleTarget?.(null, null);
            }
          }}
          onMouseLeave={() => {
            if (isConnectingLink) {
              hoverHandleTarget?.(null, null);
            }
          }}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
          className={cn(
            'canvas-node-connector-handle nodrag nopan absolute z-30 flex h-3 w-3 items-center justify-center rounded-full border border-primary/80 bg-background shadow-sm transition-all duration-150',
            'opacity-0 group-hover/canvas-node:opacity-100 hover:scale-125 hover:bg-primary hover:opacity-100 focus:opacity-100',
            isConnectingLink && 'opacity-100 scale-110',
            HANDLE_POSITION_CLASSES[side]
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
      ))}
    </>
  );
});
