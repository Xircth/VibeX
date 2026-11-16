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
  INSPECTOR_DOCK_GAP_X,
  INSPECTOR_EDGE_PREFIX,
  WORKFLOW_INSPECTOR_WIDTH,
  WORKFLOW_NODE_WIDTH,
  confirmationParentId,
  inspectorNodeId,
  inspectorParentId,
  isInspectorEdgeId,
  isStudioStepNode,
  type StudioInspectorNode,
  type StudioMode,
  type StudioNode,
  type StudioStepNode,
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
  getStepOutputPorts,
  isMultiPortStep,
  isPersistedSourceHandle,
  isPersistedTargetHandle,
  resolveValidSourceHandle,
  resolveValidTargetHandle,
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
  const resolvedTargetHandle = resolveValidTargetHandle(
    connection.targetHandle
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
  const currentTargetHandle = targetStep.targetPorts?.[sourceId] ?? 'target';
  if (
    alreadyDepends &&
    currentHandle === resolvedHandle &&
    currentTargetHandle === resolvedTargetHandle
  ) {
    return null;
  }

  const nextDependsOn = alreadyDepends
    ? targetStep.dependsOn
    : [...targetStep.dependsOn, sourceId];
  const nextBranchPorts = isPersistedSourceHandle(resolvedHandle)
    ? { ...(targetStep.branchPorts ?? {}), [sourceId]: resolvedHandle }
    : withoutRemovedBranchPorts(targetStep.branchPorts, new Set([sourceId]));
  const nextTargetPorts = isPersistedTargetHandle(resolvedTargetHandle)
    ? { ...(targetStep.targetPorts ?? {}), [sourceId]: resolvedTargetHandle }
    : withoutRemovedBranchPorts(targetStep.targetPorts, new Set([sourceId]));

  return steps.map((step) =>
    step.id === targetId
      ? {
          ...step,
          dependsOn: nextDependsOn,
          branchPorts: nextBranchPorts,
          targetPorts: nextTargetPorts,
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
  if (inspectorParentId(rawSourceId) || inspectorParentId(rawTargetId)) {
    return null;
  }
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
        targetPorts: withoutRemovedBranchPorts(step.targetPorts, removedSet),
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
      const targets = Object.entries(step.targetPorts ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return `${step.id}:${manual}:${step.dependsOn.join(',')}:${ports}:${targets}`;
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
  const inspectorManualPositionsRef = useRef(
    new Map<string, { x: number; y: number }>()
  );
  const topologySignature = useMemo(
    () => computeTopologySignature(definition),
    [definition]
  );
  const prevTopologySignatureRef = useRef(topologySignature);

  const [nodes, setNodes, rawOnNodesChange] =
    useNodesState<StudioNode>(layoutedNodes);
  const onNodesChange = useCallback(
    (changes: NodeChange<StudioNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.dragging) {
          const inspectorOwner = inspectorParentId(change.id);
          if (inspectorOwner && change.position) {
            inspectorManualPositionsRef.current.set(
              inspectorOwner,
              change.position
            );
          } else {
            draggedNodeIdsRef.current.add(change.id);
          }
        }
      }
      rawOnNodesChange(changes);
    },
    [rawOnNodesChange]
  );

  useEffect(() => {
    if (!selectedStepId) {
      inspectorManualPositionsRef.current.clear();
    }
  }, [selectedStepId]);

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
      const nextStepNodes: StudioStepNode[] = layoutedNodes.map((next) => {
        const existing = current.find(
          (node): node is StudioStepNode =>
            isStudioStepNode(node) && node.id === next.id
        );
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

      if (!selectedStepId) {
        return nextStepNodes;
      }

      const parentNode = nextStepNodes.find(
        (candidate) => candidate.id === selectedStepId
      );
      if (!parentNode) {
        return nextStepNodes;
      }

      const inspId = inspectorNodeId(selectedStepId);
      const existingInspector = current.find(
        (node): node is StudioInspectorNode =>
          !isStudioStepNode(node) && node.id === inspId
      );
      const manualPosition =
        inspectorManualPositionsRef.current.get(selectedStepId);
      const dockedPosition = {
        x: parentNode.position.x + WORKFLOW_NODE_WIDTH + INSPECTOR_DOCK_GAP_X,
        y: parentNode.position.y,
      };
      const inspectorNode: StudioInspectorNode = {
        id: inspId,
        type: 'workflowInspector',
        position: manualPosition ?? dockedPosition,
        initialWidth: WORKFLOW_INSPECTOR_WIDTH,
        initialHeight: 460,
        draggable: true,
        selectable: false,
        deletable: false,
        connectable: false,
        dragHandle: '.workflow-inspector-drag-handle',
        zIndex: 40,
        style: { width: WORKFLOW_INSPECTOR_WIDTH },
        data: { stepId: selectedStepId },
        ...(existingInspector?.measured
          ? { measured: existingInspector.measured }
          : {}),
      };

      return [...nextStepNodes, inspectorNode];
    });
  }, [layoutedNodes, selectedStepId, setNodes, topologySignature]);

  const nodePositionMap = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.position])),
    [nodes]
  );

  const derivedEdges = useMemo(() => {
    const baseEdges = buildEdges(definition, latest, t, nodePositionMap);
    if (!selectedStepId) return baseEdges;
    const selectedStep = definition.steps.find(
      (step) => step.id === selectedStepId
    );
    if (!selectedStep) return baseEdges;
    const sourceHandle = isMultiPortStep(selectedStep)
      ? (getStepOutputPorts(selectedStep, t)[0]?.id ?? 'source')
      : 'source';
    const inspectorEdge: Edge = {
      id: `${INSPECTOR_EDGE_PREFIX}${selectedStepId}`,
      type: 'workflowEdge',
      source: selectedStepId,
      target: inspectorNodeId(selectedStepId),
      sourceHandle,
      targetHandle: 'inspector-target',
      deletable: false,
      reconnectable: false,
      selectable: false,
      focusable: false,
      zIndex: 35,
      data: { isInspectorLink: true },
      className: 'workflow-studio-edge workflow-inspector-edge',
    };
    return [...baseEdges, inspectorEdge];
  }, [definition, latest, nodePositionMap, selectedStepId, t]);

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

  const revealSelectedNode = useCallback(() => {
    if (!selectedStepId || !stageRef.current || !flowInstance) {
      return;
    }
    const stageRect = stageRef.current.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;

    const inspectorEl = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(inspectorNodeId(selectedStepId))}"]`
    );
    const stepEl = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(selectedStepId)}"]`
    );
    const targetEl = inspectorEl ?? stepEl;
    if (!targetEl) return;

    const targetRect = targetEl.getBoundingClientRect();
    if (!targetRect.width && !targetRect.height) return;

    let dx = 0;
    let dy = 0;
    const rightOverflow = targetRect.right - (stageRect.right - 24);
    if (rightOverflow > 0) {
      dx = -rightOverflow;
    }
    const leftEdge = stepEl ? stepEl.getBoundingClientRect().left : targetRect.left;
    if (leftEdge + dx < stageRect.left + 24) {
      dx += stageRect.left + 24 - (leftEdge + dx);
    }
    const bottomOverflow = targetRect.bottom - (stageRect.bottom - 56);
    if (bottomOverflow > 0) {
      dy = -bottomOverflow;
    }
    if (targetRect.top + dy < stageRect.top + 56) {
      dy += stageRect.top + 56 - (targetRect.top + dy);
    }

    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const viewport = flowInstance.getViewport();
    void flowInstance.setViewport(
      { ...viewport, x: viewport.x + dx, y: viewport.y + dy },
      { duration: 180 }
    );
  }, [flowInstance, selectedStepId]);

  const confirmationOffsets = useRef(
    new Map<string, { x: number; y: number }>()
  );
  const syncConfirmationDrag = useCallback(
    (node: StudioNode) => {
      const inspectorOwner = inspectorParentId(node.id);
      if (inspectorOwner) {
        inspectorManualPositionsRef.current.set(inspectorOwner, node.position);
        return;
      }

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
      const followInspector = !inspectorManualPositionsRef.current.has(node.id);
      setNodes((current) =>
        current.map((candidate) => {
          if (
            isStudioStepNode(candidate) &&
            candidate.data.confirmationFor === node.id
          ) {
            return {
              ...candidate,
              position: {
                x: node.position.x + offset.x,
                y: node.position.y + offset.y,
              },
            };
          }
          if (
            followInspector &&
            !isStudioStepNode(candidate) &&
            candidate.id === inspectorNodeId(node.id)
          ) {
            return {
              ...candidate,
              position: {
                x: node.position.x + WORKFLOW_NODE_WIDTH + INSPECTOR_DOCK_GAP_X,
                y: node.position.y,
              },
            };
          }
          return candidate;
        })
      );
    },
    [setNodes]
  );

  useEffect(() => {
    if (!selectedStepId) return;
    const frame = requestAnimationFrame(() => {
      revealSelectedNode();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [revealSelectedNode, selectedStepId]);

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
        (edge) =>
          !edge.id.includes('->confirmation:') && !isInspectorEdgeId(edge.id)
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
          (!change.id.includes('->confirmation:') &&
            !isInspectorEdgeId(change.id) &&
            Boolean(onDefinitionChange))
      );
      rawOnEdgesChange(passthroughChanges);
    },
    [edges, onDefinitionChange, rawOnEdgesChange, removeEdges]
  );

  const reconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (
        !onDefinitionChange ||
        oldEdge.id.includes('->confirmation:') ||
        isInspectorEdgeId(oldEdge.id)
      ) {
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
    eventsByStepId,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    stageRef,
    inspectorRef,
    flowInstance,
    setFlowInstance,
    syncConfirmationDrag,
    connect,
    disconnect,
    reconnect,
    isValidConnection,
    removeEdges,
  };
}
