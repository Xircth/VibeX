import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { WorkflowEventRecord, WorkflowStepView } from 'shared/types';

import type { EventEnvelope, PulseEvalMode } from '@/lib/api/pulse';

import { latestWorkflowStepAttempts } from '../workflowProjection';
import type {
  CollaborationBotOption,
  CollaborationSpaceOption,
} from '../useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '../workflowAgent';
import {
  CONFIRMATION_OFFSET,
  WORKFLOW_NODE_WIDTH,
  confirmationParentId,
  type StudioMode,
  type StudioNode,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from './types';
import {
  isWorkflowConnectionValid,
  wouldCreateWorkflowCycle,
} from './workflowConnection';
import {
  buildEdges,
  indexWorkflowEventsByStepId,
  layoutNodes,
  withoutStepOutputBindings,
} from './workflowGraph';
import {
  defaultSourceHandleFor,
  isNamedBranchHandle,
  resolveValidSourceHandle,
  withoutRemovedBranchPorts,
  type PortTranslateFn,
} from './workflowPorts';

function applyConnectionToSteps(
  steps: StudioWorkflowStep[],
  connection: Connection
): StudioWorkflowStep[] | null {
  if (!connection.source || !connection.target) return null;
  if (!isWorkflowConnectionValid(connection, steps)) return null;

  const sourceId =
    confirmationParentId(connection.source) ?? connection.source;
  const targetId =
    confirmationParentId(connection.target) ?? connection.target;
  if (sourceId === targetId) return null;

  const sourceStep = steps.find((step) => step.id === sourceId);
  const targetStep = steps.find((step) => step.id === targetId);
  if (!sourceStep || !targetStep || targetStep.kind === 'trigger') {
    return null;
  }

  const resolvedHandle = resolveValidSourceHandle(
    sourceStep,
    connection.sourceHandle
  );

  // BoundedLoop loop-back port targeting an ancestor step sets loopTargetStepId cleanly
  // without introducing a cycle into `dependsOn`.
  if (
    sourceStep.kind === 'control' &&
    sourceStep.controlKind === 'bounded_loop' &&
    resolvedHandle === 'branch:loop_body' &&
    wouldCreateWorkflowCycle(steps, sourceId, targetId)
  ) {
    if (sourceStep.loopTargetStepId === targetId) return null;
    return steps.map((step) =>
      step.id === sourceId && step.kind === 'control'
        ? { ...step, loopTargetStepId: targetId }
        : step
    );
  }

  const alreadyDepends = targetStep.dependsOn.includes(sourceId);
  const currentHandle =
    targetStep.branchPorts?.[sourceId] ?? defaultSourceHandleFor(sourceStep);
  if (alreadyDepends && currentHandle === resolvedHandle) {
    return null;
  }

  const nextDependsOn = alreadyDepends
    ? targetStep.dependsOn
    : [...targetStep.dependsOn, sourceId];
  const nextBranchPorts = isNamedBranchHandle(resolvedHandle)
    ? { ...(targetStep.branchPorts ?? {}), [sourceId]: resolvedHandle }
    : withoutRemovedBranchPorts(targetStep.branchPorts, new Set([sourceId]));

  return steps.map((step) =>
    step.id === targetId
      ? {
          ...step,
          dependsOn: nextDependsOn,
          branchPorts: nextBranchPorts,
        }
      : step
  );
}

function applyDisconnectToSteps(
  steps: StudioWorkflowStep[],
  rawSourceId: string,
  rawTargetId: string,
  sourceHandleId?: string | null
): StudioWorkflowStep[] | null {
  const sourceId = confirmationParentId(rawSourceId) ?? rawSourceId;
  const targetId = confirmationParentId(rawTargetId) ?? rawTargetId;
  let changed = false;

  const nextSteps = steps.map((step) => {
    if (
      step.id === sourceId &&
      step.kind === 'control' &&
      step.controlKind === 'bounded_loop' &&
      step.loopTargetStepId === targetId &&
      (sourceHandleId === 'branch:loop_body' ||
        !steps
          .find((candidate) => candidate.id === targetId)
          ?.dependsOn.includes(sourceId))
    ) {
      changed = true;
      return { ...step, loopTargetStepId: '' };
    }

    if (step.id === targetId && step.dependsOn.includes(sourceId)) {
      if (
        sourceHandleId &&
        step.branchPorts?.[sourceId] &&
        step.branchPorts[sourceId] !== sourceHandleId
      ) {
        return step;
      }
      changed = true;
      const removedSet = new Set([sourceId]);
      return {
        ...step,
        dependsOn: step.dependsOn.filter((dep) => dep !== sourceId),
        branchPorts: withoutRemovedBranchPorts(step.branchPorts, removedSet),
        inputBindings: withoutStepOutputBindings(
          step.inputBindings,
          removedSet
        ),
      };
    }

    return step;
  });

  return changed ? nextSteps : null;
}

function computeTopologySignature(definition: StudioWorkflowDefinition): string {
  return definition.steps
    .map((step) => {
      const manual =
        (step.kind === 'agent' || step.kind === 'session') &&
        step.completionPolicy === 'manual'
          ? 'm'
          : 'a';
      const ports = Object.entries(step.branchPorts ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return `${step.id}:${manual}:${step.dependsOn.join(',')}:${ports}`;
    })
    .join('|');
}

export function useWorkflowStudioGraph({
  definition,
  onDefinitionChange,
  steps,
  events,
  agentOptions,
  bots,
  spaces,
  mode,
  replayEnvelope,
  onTriggerEvalModeChange,
  onQuickAddStep,
  t,
}: {
  definition: StudioWorkflowDefinition;
  onDefinitionChange?: (definition: StudioWorkflowDefinition) => void;
  steps: WorkflowStepView[];
  events: WorkflowEventRecord[];
  agentOptions: WorkflowStudioAgentOption[];
  bots?: readonly CollaborationBotOption[];
  spaces?: readonly CollaborationSpaceOption[];
  mode: StudioMode;
  replayEnvelope?: EventEnvelope | null;
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void;
  onQuickAddStep?: (parentStepId: string) => void;
  t?: PortTranslateFn;
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
  const eventsByStepId = useMemo(
    () => indexWorkflowEventsByStepId(events),
    [events]
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
        eventsByStepId,
        agentOptions,
        logStepId,
        toggleLog,
        replayEnvelope,
        onTriggerEvalModeChange,
        onQuickAddStep,
        bots,
        spaces
      ),
    [
      agentOptions,
      bots,
      definition,
      eventsByStepId,
      latest,
      logStepId,
      mode,
      onQuickAddStep,
      onTriggerEvalModeChange,
      replayEnvelope,
      selectedStepId,
      spaces,
      toggleLog,
    ]
  );
  const draggedNodeIdsRef = useRef(new Set<string>());
  const topologySignature = useMemo(
    () => computeTopologySignature(definition),
    [definition]
  );
  const prevTopologySignatureRef = useRef(topologySignature);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState(layoutedNodes);
  const onNodesChange = useCallback(
    (changes: NodeChange<StudioNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.dragging) {
          draggedNodeIdsRef.current.add(change.id);
        }
      }
      rawOnNodesChange(changes);
    },
    [rawOnNodesChange]
  );

  useEffect(() => {
    const topologyChanged =
      prevTopologySignatureRef.current !== topologySignature;
    prevTopologySignatureRef.current = topologySignature;

    if (topologyChanged) {
      const validIds = new Set(layoutedNodes.map((node) => node.id));
      for (const draggedId of Array.from(draggedNodeIdsRef.current)) {
        if (!validIds.has(draggedId)) {
          draggedNodeIdsRef.current.delete(draggedId);
        }
      }
    }

    setNodes((current) => {
      const placedStepPositions: Array<{ x: number; y: number }> = [];
      return layoutedNodes.map((next) => {
        const existing = current.find((node) => node.id === next.id);
        const isConfirmation = Boolean(next.data.confirmationFor);
        const keepExistingPosition = Boolean(
          existing &&
            (!topologyChanged || draggedNodeIdsRef.current.has(next.id))
        );

        let position =
          keepExistingPosition && existing ? existing.position : next.position;

        if (!isConfirmation && !keepExistingPosition) {
          while (
            placedStepPositions.some(
              (other) =>
                Math.abs(position.x - other.x) < WORKFLOW_NODE_WIDTH + 24 &&
                Math.abs(position.y - other.y) < 176
            )
          ) {
            position = { x: position.x, y: position.y + 216 };
          }
        }
        if (!isConfirmation) {
          placedStepPositions.push(position);
        }

        return {
          ...next,
          position,
          ...(existing?.measured ? { measured: existing.measured } : {}),
        };
      });
    });
  }, [layoutedNodes, setNodes, topologySignature]);

  const derivedEdges = useMemo(
    () => buildEdges(definition, latest, t),
    [definition, latest, t]
  );
  const [edges, setEdges, rawOnEdgesChange] = useEdgesState<Edge>(derivedEdges);
  useEffect(() => {
    setEdges((current) =>
      derivedEdges.map((next) => {
        const existing = current.find((edge) => edge.id === next.id);
        return existing?.selected ? { ...next, selected: true } : next;
      })
    );
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
      if (!onDefinitionChange) return;
      const nextSteps = applyConnectionToSteps(definition.steps, connection);
      if (!nextSteps) return;
      onDefinitionChange({ ...definition, steps: nextSteps });
    },
    [definition, onDefinitionChange]
  );

  const disconnect = useCallback(
    (sourceId: string, targetId: string, sourceHandleId?: string) => {
      if (!onDefinitionChange) return;
      const nextSteps = applyDisconnectToSteps(
        definition.steps,
        sourceId,
        targetId,
        sourceHandleId
      );
      if (!nextSteps) return;
      onDefinitionChange({ ...definition, steps: nextSteps });
    },
    [definition, onDefinitionChange]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      isWorkflowConnectionValid(connection, definition.steps),
    [definition.steps]
  );

  const removeEdges = useCallback(
    (deletedEdges: Edge[]) => {
      if (!onDefinitionChange) return;
      const removable = deletedEdges.filter(
        (edge) => !edge.id.includes('->confirmation:')
      );
      if (removable.length === 0) return;

      if (removable.length === 1) {
        const single = removable[0]!;
        disconnect(
          single.source,
          single.target,
          single.sourceHandle ?? undefined
        );
        return;
      }

      let currentSteps = definition.steps;
      let anyChanged = false;
      for (const edge of removable) {
        const updated = applyDisconnectToSteps(
          currentSteps,
          edge.source,
          edge.target,
          edge.sourceHandle ?? undefined
        );
        if (updated) {
          currentSteps = updated;
          anyChanged = true;
        }
      }
      if (anyChanged) {
        onDefinitionChange({ ...definition, steps: currentSteps });
      }
    },
    [definition, disconnect, onDefinitionChange]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const removedIds = changes
        .filter((change) => change.type === 'remove')
        .map((change) => change.id);

      if (removedIds.length > 0 && onDefinitionChange) {
        const removedEdges = edges.filter((edge) =>
          removedIds.includes(edge.id)
        );
        if (removedEdges.length > 0) {
          removeEdges(removedEdges);
        }
      }

      const passthroughChanges = changes.filter(
        (change) =>
          change.type !== 'remove' ||
          (!change.id.includes('->confirmation:') && Boolean(onDefinitionChange))
      );
      rawOnEdgesChange(passthroughChanges);
    },
    [edges, onDefinitionChange, rawOnEdgesChange, removeEdges]
  );

  const reconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (!onDefinitionChange || oldEdge.id.includes('->confirmation:')) {
        return;
      }
      const afterDisconnect =
        applyDisconnectToSteps(
          definition.steps,
          oldEdge.source,
          oldEdge.target,
          oldEdge.sourceHandle ?? undefined
        ) ?? definition.steps;
      const afterReconnect = applyConnectionToSteps(
        afterDisconnect,
        newConnection
      );
      if (!afterReconnect) return;
      onDefinitionChange({ ...definition, steps: afterReconnect });
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
    disconnect,
    reconnect,
    isValidConnection,
    removeEdges,
  };
}
