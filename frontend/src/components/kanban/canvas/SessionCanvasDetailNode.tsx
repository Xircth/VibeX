import { memo } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { SessionMonitorCard } from '@/components/kanban/session-hub/SessionMonitorCard';
import { DETAIL_MIN_HEIGHT, DETAIL_MIN_WIDTH } from './canvasModel';
import { useCanvasSession, useSessionCanvasView } from './CanvasViewContext';

export interface SessionCanvasDetailData {
  sessionId: string;
  instanceId?: string;
  slotIndex?: number | null;
  [key: string]: unknown;
}

export type SessionCanvasDetailFlowNode = Node<
  SessionCanvasDetailData,
  'sessionDetail'
>;

export const SessionCanvasDetailNode = memo(
  function SessionCanvasDetailNode({
    data,
    selected,
  }: NodeProps<SessionCanvasDetailFlowNode>) {
    const {
      sessionsReady,
      collapseCard,
      previewResize,
      resizeCard,
      resetCardSize,
    } = useSessionCanvasView();
    const instanceId = data.instanceId ?? data.sessionId;
    const session = useCanvasSession(data.sessionId);
    if (!session) {
      if (!sessionsReady) {
        return (
          <div className="h-full w-full rounded-lg bg-[var(--surface-control)]" />
        );
      }
      return null;
    }

    return (
      <div className="canvas-board-units relative h-full w-full cursor-auto select-text">
        <NodeResizer
          isVisible
          minWidth={DETAIL_MIN_WIDTH}
          minHeight={DETAIL_MIN_HEIGHT}
          lineClassName="canvas-node-resize-line"
          handleClassName="canvas-node-resize-handle"
          onResize={(_event, params) => previewResize(instanceId, params)}
          onResizeEnd={(_event, params) => resizeCard(instanceId, params)}
        />
        <SessionMonitorCard
          session={session}
          variant="canvas"
          selected={selected}
          slotIndex={typeof data.slotIndex === 'number' ? data.slotIndex : null}
          onZoom={() => resetCardSize(instanceId)}
          onClose={() => collapseCard(instanceId)}
        />
      </div>
    );
  },
  (previous, next) =>
    previous.data.sessionId === next.data.sessionId &&
    previous.data.instanceId === next.data.instanceId &&
    previous.data.slotIndex === next.data.slotIndex &&
    previous.selected === next.selected
);
