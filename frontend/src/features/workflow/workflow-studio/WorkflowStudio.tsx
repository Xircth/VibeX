import { useCallback, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  SelectionMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../workflowStudio.css';

import {
  BOARD_DOT_GAP,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
} from '@/components/kanban/canvas/canvasModel';
import { useCanvasMarqueeTextGuard } from '@/components/kanban/canvas/useCanvasMarqueeTextGuard';
import { useCanvasRightDragPan } from '@/components/kanban/canvas/useCanvasRightDragPan';
import { cn } from '@/lib/utils';

import { DraggableMiniMap } from './DraggableMiniMap';
import {
  isInspectorEdgeId,
  isStudioStepNode,
  type StudioNode,
  type StudioWorkflowDefinition,
  type WorkflowStudioDefinitionInput,
  type WorkflowStudioProps,
} from './types';
import { useWorkflowStudio } from './useWorkflowStudio';
import {
  WorkflowCanvasControls,
  type CanvasInteractionTool,
} from './WorkflowCanvasControls';
import { WorkflowStudioContextMenu } from './WorkflowStudioContextMenu';
import { WorkflowStudioProvider } from './WorkflowStudioContext';
import { WorkflowStudioToolbar } from './WorkflowStudioToolbar';
import { WorkflowStudioWorkspacePanel } from './WorkflowStudioWorkspacePanel';
import { edgeTypes } from './WorkflowStudioEdge';
import { nodeTypes } from './WorkflowStepNode';

export function WorkflowStudio<
  TDef extends WorkflowStudioDefinitionInput = StudioWorkflowDefinition,
>(props: WorkflowStudioProps<TDef>) {
  const studio = useWorkflowStudio(props);
  const {
    className,
    stageRef,
    flowInstance,
    setFlowInstance,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    setSelectedStepId,
    setInspectorTab,
    setWorkspaceOpen,
    syncConfirmationDrag,
    setContextMenu,
    connect,
    reconnect,
    isValidConnection,
    removeEdges,
    onDefinitionChange,
    activeWorktree,
  } = studio;

  const [canvasTool, setCanvasTool] = useState<CanvasInteractionTool>('select');
  const [miniMapOpen, setMiniMapOpen] = useState(false);

  const rightPanOriginRef = useRef<{
    gestureId: number;
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const onRightPan = useCallback(
    (delta: { x: number; y: number; gestureId: number }) => {
      if (!flowInstance) return;
      let origin = rightPanOriginRef.current;
      if (origin == null || origin.gestureId !== delta.gestureId) {
        const viewport = flowInstance.getViewport();
        origin = {
          gestureId: delta.gestureId,
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        };
        rightPanOriginRef.current = origin;
      }
      void flowInstance.setViewport({
        x: origin.x + delta.x,
        y: origin.y + delta.y,
        zoom: origin.zoom,
      });
    },
    [flowInstance]
  );
  useCanvasRightDragPan(stageRef, undefined, onRightPan);
  useCanvasMarqueeTextGuard(stageRef);

  return (
    <WorkflowStudioProvider value={studio}>
      <section
        data-canvas-tool={canvasTool}
        className={cn(
          'workflow-studio flex min-h-0 flex-1 flex-col bg-background',
          className
        )}
      >
        <div
          ref={stageRef}
          className="canvas-surface workflow-studio-stage relative min-h-0 flex-1 overflow-hidden"
        >
          <WorkflowStudioToolbar studio={studio} />
          <ReactFlow<StudioNode>
            onInit={setFlowInstance}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              if (!isStudioStepNode(node)) return;
              setSelectedStepId(node.data.confirmationFor ?? node.id);
              if (node.data.confirmationFor) setInspectorTab('conversation');
              setWorkspaceOpen(false);
            }}
            onNodeDrag={(_, node) => {
              syncConfirmationDrag(node);
            }}
            onNodeDragStop={(_, node) => syncConfirmationDrag(node)}
            onPaneClick={() => {
              setSelectedStepId(null);
              setContextMenu(null);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              if (!isStudioStepNode(node)) return;
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                kind: 'node',
                stepId: node.data.confirmationFor ?? node.id,
                confirmation: Boolean(node.data.confirmationFor),
              });
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
            }}
            onConnect={connect}
            onReconnect={reconnect}
            isValidConnection={isValidConnection}
            connectionMode={ConnectionMode.Loose}
            panOnDrag={canvasTool === 'pan' ? true : []}
            selectionOnDrag={canvasTool === 'select'}
            selectionMode={SelectionMode.Partial}
            panOnScroll
            selectionKeyCode={null}
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
            zoomOnDoubleClick={false}
            elevateNodesOnSelect={false}
            deleteKeyCode={onDefinitionChange ? ['Backspace', 'Delete'] : null}
            onEdgeDoubleClick={(event, edge) => {
              event.stopPropagation();
              if (
                edge.id.includes('->confirmation:') ||
                isInspectorEdgeId(edge.id)
              ) {
                return;
              }
              removeEdges([edge]);
            }}
            edgesReconnectable={Boolean(onDefinitionChange)}
            edgesFocusable={Boolean(onDefinitionChange)}
            nodesDraggable={Boolean(onDefinitionChange)}
            nodesConnectable={Boolean(onDefinitionChange)}
            proOptions={{ hideAttribution: true }}
            fitView
            fitViewOptions={{ padding: 0.24, maxZoom: 1.05 }}
            minZoom={CANVAS_MIN_ZOOM}
            maxZoom={CANVAS_MAX_ZOOM}
            colorMode="system"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={BOARD_DOT_GAP}
              size={1.5}
              className="canvas-dots"
            />
            <WorkflowCanvasControls
              tool={canvasTool}
              onToolChange={setCanvasTool}
              miniMapOpen={miniMapOpen}
              onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
              canUndo={studio.canUndo}
              onUndo={studio.onUndo}
              canRedo={studio.canRedo}
              onRedo={studio.onRedo}
            />
            {miniMapOpen ? <DraggableMiniMap /> : null}
          </ReactFlow>
          <WorkflowStudioContextMenu studio={studio} />
          {activeWorktree ? (
            <div
              className="workflow-studio-floating-controls pointer-events-none absolute bottom-3.5 left-3.5 z-20 max-w-[220px] px-2.5 py-1.5"
              data-testid="workflow-active-worktree"
            >
              <div className="truncate text-[11px] font-medium">
                {activeWorktree.name}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {activeWorktree.path}
              </div>
            </div>
          ) : null}

          <WorkflowStudioWorkspacePanel studio={studio} />
        </div>
      </section>
    </WorkflowStudioProvider>
  );
}
