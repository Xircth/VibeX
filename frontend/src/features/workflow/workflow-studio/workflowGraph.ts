import { MarkerType, Position, type Edge } from '@xyflow/react';
import type {
  WorkflowBinding,
  WorkflowEventRecord,
  WorkflowStepView,
} from 'shared/types';

import type { EventEnvelope, PulseEvalMode } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import type {
  CollaborationBotOption,
  CollaborationSpaceOption,
} from '../useCollaborationBotRoster';
import type { WorkflowStudioAgentOption } from '../workflowAgent';
import {
  CONFIRMATION_NODE_HEIGHT,
  CONFIRMATION_NODE_WIDTH,
  CONFIRMATION_OFFSET,
  EMPTY_EVENTS,
  WORKFLOW_NODE_WIDTH,
  type StudioMode,
  type StudioStepNode,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from './types';
import {
  describeBranchEdge,
  isMultiPortStep,
  resolveValidSourceHandle,
  resolveValidTargetHandle,
  type PortTranslateFn,
} from './workflowPorts';

function extractEventStepId(payloadJson: string): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object') {
      const candidate =
        parsed.step_id ?? parsed.stepId ?? parsed.loop_step_id ?? null;
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
  } catch {
    const match = /"(?:step_id|stepId)"\s*:\s*"([^"]+)"/.exec(payloadJson);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function indexWorkflowEventsByStepId(
  events: readonly WorkflowEventRecord[]
): Map<string, WorkflowEventRecord[]> {
  const byStep = new Map<string, WorkflowEventRecord[]>();
  for (const event of events) {
    const stepId = extractEventStepId(event.payloadJson);
    if (!stepId) continue;
    const bucket = byStep.get(stepId);
    if (bucket) {
      bucket.push(event);
    } else {
      byStep.set(stepId, [event]);
    }
  }
  for (const bucket of byStep.values()) {
    if (bucket.length > 1) {
      bucket.sort((left, right) =>
        left.sequence < right.sequence
          ? -1
          : left.sequence > right.sequence
            ? 1
            : 0
      );
    }
  }
  return byStep;
}

export function withoutStepOutputBindings(
  bindings: Record<string, WorkflowBinding | undefined>,
  removedStepIds: ReadonlySet<string>
) {
  return Object.fromEntries(
    Object.entries(bindings).filter(
      (entry): entry is [string, WorkflowBinding] => {
        const binding = entry[1];
        return Boolean(
          binding &&
            !(
              binding.source === 'step_output' &&
              removedStepIds.has(binding.step_id)
            )
        );
      }
    )
  );
}

export function renameStepOutputBindings(
  bindings: Record<string, WorkflowBinding | undefined>,
  fromStepId: string,
  toStepId: string
) {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([name, binding]) => {
      if (!binding) return [];
      return [
        [
          name,
          binding.source === 'step_output' && binding.step_id === fromStepId
            ? { ...binding, step_id: toStepId }
            : binding,
        ],
      ];
    })
  ) as Record<string, WorkflowBinding | undefined>;
}

function hasManualConfirmation(step: StudioWorkflowStep): boolean {
  return (
    (step.kind === 'agent' || step.kind === 'session') &&
    step.completionPolicy === 'manual'
  );
}

function computeOutgoingPortCounts(definition: StudioWorkflowDefinition): {
  byStepHandle: Map<string, Record<string, number>>;
  totalByStep: Map<string, number>;
} {
  const byStepHandle = new Map<string, Record<string, number>>();
  const totalByStep = new Map<string, number>();

  const increment = (stepId: string, handleId: string) => {
    const current = byStepHandle.get(stepId) ?? {};
    current[handleId] = (current[handleId] ?? 0) + 1;
    byStepHandle.set(stepId, current);
    totalByStep.set(stepId, (totalByStep.get(stepId) ?? 0) + 1);
  };

  for (const step of definition.steps) {
    for (const sourceStepId of step.dependsOn) {
      const sourceStep = definition.steps.find(
        (candidate) => candidate.id === sourceStepId
      );
      if (!sourceStep) continue;
      const handleId = resolveValidSourceHandle(
        sourceStep,
        step.branchPorts?.[sourceStepId]
      );
      increment(sourceStepId, handleId);
    }

    if (
      step.kind === 'control' &&
      step.controlKind === 'bounded_loop' &&
      step.loopTargetStepId
    ) {
      const loopTarget = definition.steps.find(
        (candidate) =>
          candidate.id === step.loopTargetStepId && candidate.kind !== 'trigger'
      );
      if (loopTarget && !loopTarget.dependsOn.includes(step.id)) {
        increment(step.id, 'branch:loop_body');
      }
    }
  }

  return { byStepHandle, totalByStep };
}

const LAYOUT_START_X = 56;
const STANDARD_COLUMN_STRIDE = 392;
const CONFIRMATION_COLUMN_STRIDE = 524;
const LAYOUT_SPINE_Y = 200;
const LAYOUT_ROW_STRIDE = 216;
const LAYOUT_MIN_TOP_Y = 76;

function branchPortOrderBias(handleId: string): number {
  switch (handleId) {
    case 'branch:true':
    case 'branch:approved':
    case 'branch:loop_body':
      return -36;
    case 'branch:false':
    case 'branch:rejected':
    case 'branch:loop_exit':
      return 36;
    default:
      return 0;
  }
}

export function layoutNodes(
  definition: StudioWorkflowDefinition,
  latest: Map<string, WorkflowStepView>,
  selectedStepId: string | null,
  mode: StudioMode,
  onSelect: (stepId: string) => void,
  eventsInput:
    | WorkflowEventRecord[]
    | ReadonlyMap<string, WorkflowEventRecord[]>,
  agentOptions: WorkflowStudioAgentOption[],
  logStepId: string | null,
  onToggleLog: (stepId: string) => void,
  replayEnvelope?: EventEnvelope | null,
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void,
  onQuickAddStep?: (parentStepId: string) => void,
  bots?: readonly CollaborationBotOption[],
  spaces?: readonly CollaborationSpaceOption[]
): StudioStepNode[] {
  const eventsByStepId =
    'size' in eventsInput
      ? eventsInput
      : indexWorkflowEventsByStepId(eventsInput);
  const { byStepHandle, totalByStep } = computeOutgoingPortCounts(definition);
  const stepById = new Map(definition.steps.map((step) => [step.id, step]));

  const depths = new Map<string, number>();
  const depthOf = (
    step: StudioWorkflowStep,
    seen = new Set<string>()
  ): number => {
    const cached = depths.get(step.id);
    if (cached !== undefined) return cached;
    if (seen.has(step.id)) return 0;
    seen.add(step.id);
    const depth = step.dependsOn.reduce((maximum, dependency) => {
      const source = stepById.get(dependency);
      return source ? Math.max(maximum, depthOf(source, seen) + 1) : maximum;
    }, 0);
    depths.set(step.id, depth);
    return depth;
  };

  const columns = new Map<
    number,
    Array<{ step: StudioWorkflowStep; index: number }>
  >();
  let maxDepth = 0;
  definition.steps.forEach((step, index) => {
    const depth = depthOf(step);
    maxDepth = Math.max(maxDepth, depth);
    const bucket = columns.get(depth);
    if (bucket) {
      bucket.push({ step, index });
    } else {
      columns.set(depth, [{ step, index }]);
    }
  });

  const columnX = new Map<number, number>();
  let cursorX = LAYOUT_START_X;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    columnX.set(depth, cursorX);
    const bucket = columns.get(depth) ?? [];
    const columnHasManualConfirmation = bucket.some(({ step }) =>
      hasManualConfirmation(step)
    );
    cursorX += columnHasManualConfirmation
      ? CONFIRMATION_COLUMN_STRIDE
      : STANDARD_COLUMN_STRIDE;
  }

  const positionsByStepId = new Map<string, { x: number; y: number }>();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const bucket = columns.get(depth);
    if (!bucket || bucket.length === 0) continue;

    const ordered = [...bucket].sort((left, right) => {
      const targetYFor = (entry: { step: StudioWorkflowStep; index: number }) => {
        const samples: number[] = [];
        for (const sourceId of entry.step.dependsOn) {
          const predPos = positionsByStepId.get(sourceId);
          if (!predPos) continue;
          const sourceStep = stepById.get(sourceId);
          const handleId = resolveValidSourceHandle(
            sourceStep,
            entry.step.branchPorts?.[sourceId]
          );
          samples.push(predPos.y + branchPortOrderBias(handleId));
        }
        if (samples.length === 0) {
          return LAYOUT_SPINE_Y + entry.index * 0.01;
        }
        return (
          samples.reduce((sum, value) => sum + value, 0) / samples.length
        );
      };

      const delta = targetYFor(left) - targetYFor(right);
      return Math.abs(delta) > 0.001 ? delta : left.index - right.index;
    });

    const topOffset = Math.round(
      Math.max(
        LAYOUT_MIN_TOP_Y,
        LAYOUT_SPINE_Y - ((ordered.length - 1) * LAYOUT_ROW_STRIDE) / 2
      )
    );
    const x = columnX.get(depth) ?? LAYOUT_START_X;
    ordered.forEach(({ step }, rowIndex) => {
      positionsByStepId.set(step.id, {
        x,
        y: topOffset + rowIndex * LAYOUT_ROW_STRIDE,
      });
    });
  }

  const edgesForHandles = buildEdges(
    definition,
    latest,
    undefined,
    positionsByStepId
  );
  const connectedByNode = new Map<string, Set<string>>();
  const markConnected = (nodeId: string, handleId?: string | null) => {
    if (!handleId) return;
    const set = connectedByNode.get(nodeId) ?? new Set<string>();
    set.add(handleId);
    connectedByNode.set(nodeId, set);
  };
  for (const edge of edgesForHandles) {
    markConnected(edge.source, edge.sourceHandle);
    markConnected(edge.target, edge.targetHandle);
  }

  const stepNodes: StudioStepNode[] = definition.steps.map((step) => {
    const position = positionsByStepId.get(step.id) ?? {
      x: LAYOUT_START_X,
      y: LAYOUT_SPINE_Y,
    };
    const estimatedHeight = isMultiPortStep(step) ? 168 : 124;
    return {
      id: step.id,
      type: 'workflowStep',
      position,
      initialWidth: WORKFLOW_NODE_WIDTH,
      initialHeight: estimatedHeight,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      deletable: false,
      zIndex:
        selectedStepId === step.id ? 5 : logStepId === step.id ? 4 : undefined,
      style: { width: WORKFLOW_NODE_WIDTH },
      data: {
        step,
        stepRun: latest.get(step.id),
        predecessorRuns: step.dependsOn.flatMap((id) => {
          const run = latest.get(id);
          return run ? [run] : [];
        }),
        events: eventsByStepId.get(step.id) ?? EMPTY_EVENTS,
        agentOptions,
        bots,
        spaces,
        selected: selectedStepId === step.id,
        logExpanded: logStepId === step.id,
        mode,
        replayEnvelope,
        outgoingCounts: byStepHandle.get(step.id),
        totalOutgoingCount: totalByStep.get(step.id) ?? 0,
        connectedHandles: connectedByNode.get(step.id),
        onSelect,
        onToggleLog,
        onTriggerEvalModeChange,
        onQuickAddStep,
      },
    };
  });

  const stepNodeById = new Map(stepNodes.map((node) => [node.id, node]));
  const confirmationNodes = definition.steps.flatMap((step) => {
    if (!hasManualConfirmation(step)) return [];
    const owner = stepNodeById.get(step.id);
    if (!owner) return [];
    const confirmId = `confirmation:${step.id}`;
    return [
      {
        id: confirmId,
        type: 'workflowStep' as const,
        position: (() => {
          const successorNodes = definition.steps
            .filter((candidate) => candidate.dependsOn.includes(step.id))
            .flatMap((candidate) => {
              const found = stepNodeById.get(candidate.id);
              return found ? [found] : [];
            });
          const successorNode = successorNodes.sort(
            (left, right) =>
              Math.abs(left.position.y - owner.position.y) -
              Math.abs(right.position.y - owner.position.y)
          )[0];
          if (
            successorNode &&
            successorNode.position.x >
              owner.position.x + WORKFLOW_NODE_WIDTH + CONFIRMATION_NODE_WIDTH
          ) {
            return {
              x: Math.round(
                (owner.position.x +
                  WORKFLOW_NODE_WIDTH +
                  successorNode.position.x -
                  CONFIRMATION_NODE_WIDTH) /
                  2
              ),
              y: Math.round(
                (owner.position.y + successorNode.position.y) / 2 +
                  CONFIRMATION_OFFSET.y
              ),
            };
          }
          return {
            x: owner.position.x + CONFIRMATION_OFFSET.x,
            y: owner.position.y + CONFIRMATION_OFFSET.y,
          };
        })(),
        initialWidth: CONFIRMATION_NODE_WIDTH,
        initialHeight: CONFIRMATION_NODE_HEIGHT,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selectable: true,
        deletable: false,
        style: {
          width: CONFIRMATION_NODE_WIDTH,
          height: CONFIRMATION_NODE_HEIGHT,
        },
        data: {
          step,
          confirmationFor: step.id,
          stepRun: latest.get(step.id),
          predecessorRuns: [],
          events: EMPTY_EVENTS,
          agentOptions,
          bots,
          spaces,
          selected: selectedStepId === step.id,
          logExpanded: false,
          mode,
          replayEnvelope,
          outgoingCounts: byStepHandle.get(step.id),
          totalOutgoingCount: totalByStep.get(step.id) ?? 0,
          connectedHandles: connectedByNode.get(confirmId),
          onSelect,
          onToggleLog,
          onTriggerEvalModeChange,
        },
      } satisfies StudioStepNode,
    ];
  });
  return [...stepNodes, ...confirmationNodes];
}

export function buildEdges(
  definition: StudioWorkflowDefinition,
  latest: Map<string, WorkflowStepView>,
  t?: PortTranslateFn,
  nodePositions?: ReadonlyMap<string, { x: number; y: number }>
): Edge[] {
  const stepById = new Map(definition.steps.map((step) => [step.id, step]));

  // Group standard-step outgoing dependents so multi-edge fan-out distributes across upper/lower right ports
  const standardSuccessorsBySource = new Map<string, string[]>();
  for (const step of definition.steps) {
    for (const sourceId of step.dependsOn) {
      const sourceStep = stepById.get(sourceId);
      if (!sourceStep || isMultiPortStep(sourceStep)) continue;
      if (step.branchPorts?.[sourceId]) continue;
      const list = standardSuccessorsBySource.get(sourceId) ?? [];
      list.push(step.id);
      standardSuccessorsBySource.set(sourceId, list);
    }
  }
  if (nodePositions) {
    for (const list of standardSuccessorsBySource.values()) {
      list.sort(
        (leftId, rightId) =>
          (nodePositions.get(leftId)?.y ?? 0) -
          (nodePositions.get(rightId)?.y ?? 0)
      );
    }
  }

  const dependencyEdges = definition.steps.flatMap((step) => {
    const orderedPreds = [...step.dependsOn];
    if (nodePositions && orderedPreds.length >= 2) {
      orderedPreds.sort(
        (leftId, rightId) =>
          (nodePositions.get(leftId)?.y ?? 0) -
          (nodePositions.get(rightId)?.y ?? 0)
      );
    }

    return step.dependsOn.map((sourceStepId) => {
      const sourceStep = stepById.get(sourceStepId);
      const hasConfirm = Boolean(
        sourceStep && hasManualConfirmation(sourceStep)
      );
      const source = hasConfirm
        ? `confirmation:${sourceStepId}`
        : sourceStepId;

      const sourcePos = nodePositions?.get(source);
      const targetPos = nodePositions?.get(step.id);
      const explicitSourceHandle = step.branchPorts?.[sourceStepId];
      const explicitTargetHandle = step.targetPorts?.[sourceStepId];

      const isPredominantlyVertical =
        !explicitSourceHandle &&
        !explicitTargetHandle &&
        !hasConfirm &&
        sourceStep &&
        !isMultiPortStep(sourceStep) &&
        sourcePos &&
        targetPos &&
        targetPos.y - sourcePos.y >
          Math.max(108, Math.abs(targetPos.x - sourcePos.x) * 0.9);

      let sourceHandle: string;
      if (hasConfirm) {
        sourceHandle = 'source';
      } else if (explicitSourceHandle) {
        sourceHandle = resolveValidSourceHandle(
          sourceStep,
          explicitSourceHandle
        );
      } else if (isPredominantlyVertical) {
        sourceHandle = 'source:bottom';
      } else {
        const siblings = standardSuccessorsBySource.get(sourceStepId);
        if (siblings && siblings.length >= 2) {
          const siblingIndex = siblings.indexOf(step.id);
          sourceHandle =
            siblingIndex >= Math.ceil(siblings.length / 2)
              ? 'source:secondary'
              : 'source';
        } else {
          sourceHandle = resolveValidSourceHandle(sourceStep, undefined);
        }
      }

      let targetHandle: string;
      if (explicitTargetHandle) {
        targetHandle = resolveValidTargetHandle(explicitTargetHandle);
      } else if (isPredominantlyVertical || sourceHandle === 'source:bottom') {
        targetHandle = 'target:top';
      } else if (orderedPreds.length >= 2) {
        const predIndex = orderedPreds.indexOf(sourceStepId);
        targetHandle =
          predIndex >= Math.ceil(orderedPreds.length / 2)
            ? 'target:secondary'
            : 'target';
      } else {
        targetHandle = 'target';
      }

      const branchMeta = hasConfirm ? {} : describeBranchEdge(sourceHandle, t);
      const sourceStatus = latest.get(sourceStepId)?.status;
      const targetStatus = latest.get(step.id)?.status;
      return {
        id: `${sourceStepId}->${step.id}`,
        type: 'workflowEdge',
        source,
        target: step.id,
        sourceHandle,
        targetHandle,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 13,
          height: 13,
        },
        ...(branchMeta.label
          ? {
              label: branchMeta.label,
              data: { branchAccent: branchMeta.accent },
            }
          : {}),
        animated:
          sourceStatus === 'running' ||
          sourceStatus === 'claimed' ||
          targetStatus === 'running' ||
          targetStatus === 'claimed',
        className: cn(
          'workflow-studio-edge',
          branchMeta.edgeClassName,
          sourceStatus === 'completed' && 'workflow-edge-completed'
        ),
      } satisfies Edge;
    });
  });

  const loopBackEdges = definition.steps.flatMap((step) => {
    if (
      step.kind !== 'control' ||
      step.controlKind !== 'bounded_loop' ||
      !step.loopTargetStepId
    ) {
      return [];
    }
    const loopTarget = stepById.get(step.loopTargetStepId);
    if (
      !loopTarget ||
      loopTarget.kind === 'trigger' ||
      loopTarget.dependsOn.includes(step.id)
    ) {
      return [];
    }
    const branchMeta = describeBranchEdge('branch:loop_body', t);
    const loopStatus = latest.get(step.id)?.status;
    return [
      {
        id: `${step.id}-loopback->${loopTarget.id}`,
        type: 'workflowEdge',
        source: step.id,
        target: loopTarget.id,
        sourceHandle: 'branch:loop_body',
        targetHandle: 'target:secondary',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 13,
          height: 13,
        },
        ...(branchMeta.label
          ? {
              label: branchMeta.label,
              data: { branchAccent: branchMeta.accent, isLoopBack: true },
            }
          : {}),
        animated: loopStatus === 'running' || loopStatus === 'claimed',
        className: cn(
          'workflow-studio-edge',
          branchMeta.edgeClassName,
          'workflow-edge-loopback'
        ),
      } satisfies Edge,
    ];
  });

  const confirmationEdges = definition.steps.flatMap((step) =>
    hasManualConfirmation(step)
      ? [
          {
            id: `${step.id}->confirmation:${step.id}`,
            type: 'workflowEdge',
            source: step.id,
            target: `confirmation:${step.id}`,
            sourceHandle: 'source',
            targetHandle: 'target',
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 13,
              height: 13,
            },
            deletable: false,
            reconnectable: false,
            focusable: false,
            animated:
              latest.get(step.id)?.awaitingAcceptance === true ||
              latest.get(step.id)?.status === 'running',
            className: cn(
              'workflow-studio-edge',
              latest.get(step.id)?.status === 'completed' &&
                'workflow-edge-completed'
            ),
          } satisfies Edge,
        ]
      : []
  );

  return [...dependencyEdges, ...loopBackEdges, ...confirmationEdges];
}

export function buildWorkflowGraph(params: {
  definition: StudioWorkflowDefinition;
  latest?: Map<string, WorkflowStepView>;
  selectedStepId?: string | null;
  mode?: StudioMode;
  onSelect?: (stepId: string) => void;
  events?: WorkflowEventRecord[] | ReadonlyMap<string, WorkflowEventRecord[]>;
  agentOptions?: WorkflowStudioAgentOption[];
  bots?: readonly CollaborationBotOption[];
  spaces?: readonly CollaborationSpaceOption[];
  logStepId?: string | null;
  onToggleLog?: (stepId: string) => void;
  replayEnvelope?: EventEnvelope | null;
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void;
  onQuickAddStep?: (parentStepId: string) => void;
  t?: PortTranslateFn;
}): { nodes: StudioStepNode[]; edges: Edge[] } {
  const latest = params.latest ?? new Map<string, WorkflowStepView>();
  const noop = () => undefined;
  const nodes = layoutNodes(
    params.definition,
    latest,
    params.selectedStepId ?? null,
    params.mode ?? 'edit',
    params.onSelect ?? noop,
    params.events ?? EMPTY_EVENTS,
    params.agentOptions ?? [],
    params.logStepId ?? null,
    params.onToggleLog ?? noop,
    params.replayEnvelope,
    params.onTriggerEvalModeChange,
    params.onQuickAddStep,
    params.bots,
    params.spaces
  );
  const positionMap = new Map(nodes.map((node) => [node.id, node.position]));
  return {
    nodes,
    edges: buildEdges(params.definition, latest, params.t, positionMap),
  };
}
