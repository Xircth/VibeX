import { Background, Controls, ConnectionMode, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../workflowStudio.css';

import { cn } from '@/lib/utils';

import { DraggableMiniMap } from './DraggableMiniMap';
import type { StudioNode, WorkflowStudioProps } from './types';
import { useWorkflowStudio } from './useWorkflowStudio';
import { WorkflowStudioContextMenu } from './WorkflowStudioContextMenu';
import { WorkflowStudioInspector } from './WorkflowStudioInspector';
import { WorkflowStudioToolbar } from './WorkflowStudioToolbar';
import { WorkflowStudioWorkspacePanel } from './WorkflowStudioWorkspacePanel';
import { nodeTypes } from './WorkflowStepNode';

export function WorkflowStudio(props: WorkflowStudioProps) {
  const studio = useWorkflowStudio(props);
  const {
    className,
    stageRef,
    setFlowInstance,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    setSelectedStepId,
    setInspectorTab,
    setWorkspaceOpen,
    syncConfirmationDrag,
    updateTether,
    setContextMenu,
    connect,
    isValidConnection,
    removeEdges,
    onDefinitionChange,
    selectedStep,
    tetherPath,
    activeWorktree,
  } = studio;

  return (
    <section
      className={cn(
        'workflow-studio flex min-h-0 flex-1 flex-col bg-background',
        className
      )}
    >
      <div
        ref={stageRef}
        className="workflow-studio-stage relative min-h-0 flex-1 overflow-hidden"
      >
        <WorkflowStudioToolbar studio={studio} />
        <ReactFlow<StudioNode>
          onInit={setFlowInstance}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => {
            setSelectedStepId(node.data.confirmationFor ?? node.id);
            if (node.data.confirmationFor) setInspectorTab('conversation');
            setWorkspaceOpen(false);
          }}
          onNodeDrag={(_, node) => {
            syncConfirmationDrag(node);
            updateTether();
          }}
          onNodeDragStop={(_, node) => syncConfirmationDrag(node)}
          onPaneClick={() => {
            setSelectedStepId(null);
            setContextMenu(null);
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
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
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              kind: 'pane',
            });
          }}
          onMove={() => updateTether()}
          onConnect={connect}
          isValidConnection={isValidConnection}
          connectionMode={ConnectionMode.Loose}
          onEdgesDelete={removeEdges}
          onEdgeDoubleClick={(event, edge) => {
            event.stopPropagation();
            if (edge.id.includes('confirmation:')) return;
            removeEdges([edge]);
          }}
          edgesReconnectable={false}
          nodesDraggable={Boolean(onDefinitionChange)}
          nodesConnectable={Boolean(onDefinitionChange)}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
          minZoom={0.35}
          maxZoom={1.65}
          colorMode="system"
        >
          <Background gap={22} size={1} color="var(--border)" />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
          />
          <DraggableMiniMap />
        </ReactFlow>
        <WorkflowStudioContextMenu studio={studio} />
        {activeWorktree ? (
          <div
            className="workflow-studio-floating-controls pointer-events-none absolute bottom-3 right-3 z-20 max-w-[220px] px-2.5 py-1.5"
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

        {selectedStep ? (
          <svg
            className="workflow-inspector-tether pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
            data-testid="workflow-inspector-tether"
            aria-hidden="true"
          >
            <path d={tetherPath} fill="none" />
          </svg>
        ) : null}

        <WorkflowStudioWorkspacePanel studio={studio} />
        {selectedStep ? <WorkflowStudioInspector studio={studio} /> : null}
      </div>
    </section>
  );
}
