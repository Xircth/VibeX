import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

import { cn } from '@/lib/utils';

import type { StudioPortAccent } from './workflowPorts';

function edgeBadgeClass(accent?: StudioPortAccent): string {
  switch (accent) {
    case 'success':
      return 'border-success/35 bg-card text-success';
    case 'warning':
      return 'border-warning/40 bg-card text-warning';
    case 'destructive':
      return 'border-destructive/35 bg-card text-destructive';
    case 'primary':
      return 'border-primary/35 bg-card text-primary';
    default:
      return 'border-border bg-card text-foreground';
  }
}

export const WorkflowStudioEdge = memo(function WorkflowStudioEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerStart,
  markerEnd,
  label,
  data,
}: EdgeProps) {
  const edgeData = data as
    | { branchAccent?: StudioPortAccent; isLoopBack?: boolean }
    | undefined;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: edgeData?.isLoopBack ? 30 : 22,
  });

  const accent = edgeData?.branchAccent;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={20}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            data-testid={`workflow-edge-label-${id}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            className={cn(
              'nodrag nopan pointer-events-none rounded-[6px] border px-1.5 py-0.5 text-[11px] font-medium leading-none shadow-sm',
              edgeBadgeClass(accent)
            )}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export const edgeTypes = { workflowEdge: WorkflowStudioEdge };
