import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import type {
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowStepView,
} from 'shared/types';

import { latestWorkflowStepAttempts } from '../workflowProjection';
import type { WorkflowStudioAgentOption } from '../workflowAgent';
import {
  CONFIRMATION_OFFSET,
  confirmationParentId,
  type StudioMode,
  type StudioNode,
} from './types';
import { isWorkflowConnectionValid } from './workflowConnection';
import {
  buildEdges,
  layoutNodes,
  withoutStepOutputBindings,
} from './workflowGraph';

export function useWorkflowStudioGraph({
  definition,
  onDefinitionChange,
  steps,
  events,
  agentOptions,
  mode,
}: {
  definition: WorkflowDefinition;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  steps: WorkflowStepView[];
  events: WorkflowEventRecord[];
  agentOptions: WorkflowStudioAgentOption[];
  mode: StudioMode;
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [logStepId, setLogStepId] = useState<string | null>(null);
  const latest = useMemo(
    () =>
      new Map(
        latestWorkflowStepAttempts(steps).map((step) => [step.stepId, step])
      ),
    [steps]
  );
  const toggleLog = useCallback((stepId: string) => {
    setLogStepId((current) => (current === stepId ? null : stepId));
  }, []);
  const layoutedNodes = useMemo(
    () =>
      layoutNodes(
        definition,
        latest,
        selectedStepId,
        mode,
        setSelectedStepId,
        events,
        agentOptions,
        logStepId,
        toggleLog
      ),
    [
      agentOptions,
      definition,
      events,
      latest,
      logStepId,
      mode,
      selectedStepId,
      toggleLog,
    ]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  useEffect(() => {
    setNodes((current) =>
      layoutedNodes.map((next) => {
        const existing = current.find((node) => node.id === next.id);
        return existing ? { ...next, position: existing.position } : next;
      })
    );
  }, [layoutedNodes, setNodes]);
  const derivedEdges = useMemo(
    () => buildEdges(definition, latest),
    [definition, latest]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(derivedEdges);
  useEffect(() => {
    setEdges(derivedEdges);
  }, [derivedEdges, setEdges]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<StudioNode> | null>(null);
  const [tetherPath, setTetherPath] = useState('');

  const revealSelectedNode = useCallback(() => {
    if (
      !selectedStepId ||
      !stageRef.current ||
      !inspectorRef.current ||
      !flowInstance
    ) {
      return;
    }
    const node = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(selectedStepId)}"]`
    );
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const inspectorRect = inspectorRef.current.getBoundingClientRect();
    const overlap = nodeRect.right - (inspectorRect.left - 28);
    if (overlap <= 0) return;
    const viewport = flowInstance.getViewport();
    void flowInstance.setViewport(
      { ...viewport, x: viewport.x - overlap },
      { duration: 180 }
    );
  }, [flowInstance, selectedStepId]);

  const confirmationOffsets = useRef(
    new Map<string, { x: number; y: number }>()
  );
  const syncConfirmationDrag = useCallback(
    (node: StudioNode) => {
      const parentId = confirmationParentId(node.id);
      if (parentId) {
        setNodes((current) => {
          const owner = current.find((candidate) => candidate.id === parentId);
          if (owner) {
            confirmationOffsets.current.set(parentId, {
              x: node.position.x - owner.position.x,
              y: node.position.y - owner.position.y,
            });
          }
          return current;
        });
        return;
      }
      const offset =
        confirmationOffsets.current.get(node.id) ?? CONFIRMATION_OFFSET;
      setNodes((current) =>
        current.map((candidate) =>
          candidate.data.confirmationFor === node.id
            ? {
                ...candidate,
                position: {
                  x: node.position.x + offset.x,
                  y: node.position.y + offset.y,
                },
              }
            : candidate
        )
      );
    },
    [setNodes]
  );

  const updateTether = useCallback(() => {
    if (!selectedStepId || !stageRef.current || !inspectorRef.current) {
      setTetherPath('');
      return;
    }
    const stageRect = stageRef.current.getBoundingClientRect();
    const node = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(selectedStepId)}"]`
    );
    if (!node) {
      setTetherPath('');
      return;
    }
    const nodeRect = node.getBoundingClientRect();
    const inspectorRect = inspectorRef.current.getBoundingClientRect();
    const startX = nodeRect.left - stageRect.left + nodeRect.width * 0.72;
    const startY = nodeRect.top - stageRect.top;
    const endX = inspectorRect.left - stageRect.left;
    const endY = inspectorRect.top - stageRect.top + 38;
    setTetherPath(`M ${startX} ${startY} V ${endY} H ${endX}`);
  }, [selectedStepId]);
  const tetherFrameRef = useRef(0);
  const scheduleTetherUpdate = useCallback(() => {
    if (tetherFrameRef.current) return;
    tetherFrameRef.current = window.requestAnimationFrame(() => {
      tetherFrameRef.current = 0;
      updateTether();
    });
  }, [updateTether]);
  useEffect(
    () => () => {
      if (tetherFrameRef.current) {
        window.cancelAnimationFrame(tetherFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedStepId) return;
    const frame = requestAnimationFrame(() => {
      revealSelectedNode();
      updateTether();
    });
    const observer = new ResizeObserver(updateTether);
    if (stageRef.current) observer.observe(stageRef.current);
    if (inspectorRef.current) observer.observe(inspectorRef.current);
    window.addEventListener('resize', updateTether);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updateTether);
    };
  }, [revealSelectedNode, selectedStepId, updateTether]);

  useEffect(() => {
    if (
      selectedStepId &&
      !definition.steps.some((step) => step.id === selectedStepId)
    ) {
      setSelectedStepId(null);
    }
  }, [definition.steps, selectedStepId]);

  const connect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !onDefinitionChange)
        return;
      if (!isWorkflowConnectionValid(connection)) return;
      const sourceId =
        confirmationParentId(connection.source) ?? connection.source;
      const targetId =
        confirmationParentId(connection.target) ?? connection.target;
      if (sourceId === targetId) return;
      const target = definition.steps.find((step) => step.id === targetId);
      if (!target || target.dependsOn.includes(sourceId)) return;
      onDefinitionChange({
        ...definition,
        steps: definition.steps.map((step) =>
          step.id === targetId
            ? { ...step, dependsOn: [...step.dependsOn, sourceId] }
            : step
        ),
      });
    },
    [definition, onDefinitionChange]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => isWorkflowConnectionValid(connection),
    []
  );

  const removeEdges = useCallback(
    (deletedEdges: Edge[]) => {
      if (!onDefinitionChange) return;
      const deleted = new Set(
        deletedEdges
          .filter((edge) => !edge.id.includes('confirmation:'))
          .map((edge) => edge.id)
      );
      if (deleted.size === 0) return;
      onDefinitionChange({
        ...definition,
        steps: definition.steps.map((step) => {
          const removedSources = new Set(
            step.dependsOn.filter((source) =>
              deleted.has(`${source}->${step.id}`)
            )
          );
          return {
            ...step,
            dependsOn: step.dependsOn.filter(
              (source) => !removedSources.has(source)
            ),
            inputBindings: withoutStepOutputBindings(
              step.inputBindings,
              removedSources
            ),
          };
        }),
      });
    },
    [definition, onDefinitionChange]
  );

  return {
    selectedStepId,
    setSelectedStepId,
    logStepId,
    setLogStepId,
    latest,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    stageRef,
    inspectorRef,
    setFlowInstance,
    tetherPath,
    syncConfirmationDrag,
    updateTether: scheduleTetherUpdate,
    connect,
    isValidConnection,
    removeEdges,
  };
}
