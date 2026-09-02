import { memo } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { SessionMonitorCard } from '@/components/kanban/session-hub/SessionMonitorCard';
import { CanvasNodeAnchors } from './CanvasNodeAnchors';
import { DETAIL_MIN_HEIGHT, DETAIL_MIN_WIDTH } from './canvasModel';
import { useSessionCanvasView } from './CanvasViewContext';

export interface SessionCanvasDetailData {
  sessionId: string;
  instanceId?: string;
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
      sessionsById,
      sessionsReady,
      collapseCard,
      previewResize,
      resizeCard,
      resetCardSize,
    } = useSessionCanvasView();
    const instanceId = data.instanceId ?? data.sessionId;
    const session = sessionsById.get(data.sessionId);
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
        <CanvasNodeAnchors />
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
          onZoom={() => resetCardSize(instanceId)}
          onClose={() => collapseCard(instanceId)}
        />
      </div>
    );
  },
  (previous, next) =>
    previous.data.sessionId === next.data.sessionId &&
    previous.data.instanceId === next.data.instanceId &&
    previous.selected === next.selected
);
