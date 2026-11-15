import { Position, type Edge } from '@xyflow/react';
import type {
  WorkflowBinding,
  WorkflowEventRecord,
  WorkflowStepView,
} from 'shared/types';

import type { EventEnvelope, PulseEvalMode } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import type { WorkflowStudioAgentOption } from '../workflowAgent';
import {
  CONFIRMATION_OFFSET,
  EMPTY_EVENTS,
  type StudioMode,
  type StudioNode,
  type StudioWorkflowDefinition,
  type StudioWorkflowStep,
} from './types';
import {
  describeBranchEdge,
  isMultiPortStep,
  resolveValidSourceHandle,
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
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void
): StudioNode[] {
  const eventsByStepId =
    'size' in eventsInput
      ? eventsInput
      : indexWorkflowEventsByStepId(eventsInput);
  const { byStepHandle, totalByStep } = computeOutgoingPortCounts(definition);

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
      const source = definition.steps.find(
        (candidate) => candidate.id === dependency
      );
      return source ? Math.max(maximum, depthOf(source, seen) + 1) : maximum;
    }, 0);
    depths.set(step.id, depth);
    return depth;
  };
  const rows = new Map<number, number>();
  const stepNodes: StudioNode[] = definition.steps.map((step) => {
    const depth = depthOf(step);
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    const estimatedHeight = isMultiPortStep(step) ? 148 : 112;
    return {
      id: step.id,
      type: 'workflowStep',
      position: { x: depth * 430 + 44, y: row * 196 + 76 },
      initialWidth: 260,
      initialHeight: estimatedHeight,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      deletable: false,
      zIndex:
        selectedStepId === step.id ? 5 : logStepId === step.id ? 4 : undefined,
      style: { width: 260 },
      data: {
        step,
        stepRun: latest.get(step.id),
        predecessorRuns: step.dependsOn.flatMap((id) => {
          const run = latest.get(id);
          return run ? [run] : [];
        }),
        events: eventsByStepId.get(step.id) ?? EMPTY_EVENTS,
        agentOptions,
        selected: selectedStepId === step.id,
        logExpanded: logStepId === step.id,
        mode,
        replayEnvelope,
        outgoingCounts: byStepHandle.get(step.id),
        totalOutgoingCount: totalByStep.get(step.id) ?? 0,
        onSelect,
        onToggleLog,
        onTriggerEvalModeChange,
      },
    };
  });

  const confirmationNodes = definition.steps.flatMap((step) => {
    if (!hasManualConfirmation(step)) return [];
    const owner = stepNodes.find((node) => node.id === step.id);
    if (!owner) return [];
    return [
      {
        id: `confirmation:${step.id}`,
        type: 'workflowStep' as const,
        position: (() => {
          const successor = definition.steps.find((candidate) =>
            candidate.dependsOn.includes(step.id)
          );
          const successorNode = successor
            ? stepNodes.find((node) => node.id === successor.id)
            : undefined;
          if (successorNode) {
            return {
              x: (owner.position.x + successorNode.position.x) / 2,
              y: (owner.position.y + successorNode.position.y) / 2,
            };
          }
          return {
            x: owner.position.x + CONFIRMATION_OFFSET.x,
            y: owner.position.y + CONFIRMATION_OFFSET.y,
          };
        })(),
        initialWidth: 144,
        initialHeight: 48,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selectable: true,
        deletable: false,
        style: { width: 144, height: 48 },
        data: {
          step,
          confirmationFor: step.id,
          stepRun: latest.get(step.id),
          predecessorRuns: [],
          events: EMPTY_EVENTS,
          agentOptions,
          selected: selectedStepId === step.id,
          logExpanded: false,
          mode,
          replayEnvelope,
          outgoingCounts: byStepHandle.get(step.id),
          totalOutgoingCount: totalByStep.get(step.id) ?? 0,
          onSelect,
          onToggleLog,
          onTriggerEvalModeChange,
        },
      } satisfies StudioNode,
    ];
  });
  return [...stepNodes, ...confirmationNodes];
}

export function buildEdges(
  definition: StudioWorkflowDefinition,
  latest: Map<string, WorkflowStepView>,
  t?: PortTranslateFn
): Edge[] {
  const dependencyEdges = definition.steps.flatMap((step) =>
    step.dependsOn.map((sourceStepId) => {
      const sourceStep = definition.steps.find(
        (candidate) => candidate.id === sourceStepId
      );
      const hasConfirm = Boolean(sourceStep && hasManualConfirmation(sourceStep));
      const source = hasConfirm
        ? `confirmation:${sourceStepId}`
        : sourceStepId;
      const sourceHandle = hasConfirm
        ? 'source'
        : resolveValidSourceHandle(
            sourceStep,
            step.branchPorts?.[sourceStepId]
          );
      const branchMeta = hasConfirm ? {} : describeBranchEdge(sourceHandle, t);
      const sourceStatus = latest.get(sourceStepId)?.status;
      const targetStatus = latest.get(step.id)?.status;
      return {
        id: `${sourceStepId}->${step.id}`,
        type: 'workflowEdge',
        source,
        target: step.id,
        sourceHandle,
        targetHandle: 'target',
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
    })
  );

  const loopBackEdges = definition.steps.flatMap((step) => {
    if (
      step.kind !== 'control' ||
      step.controlKind !== 'bounded_loop' ||
      !step.loopTargetStepId
    ) {
      return [];
    }
    const loopTarget = definition.steps.find(
      (candidate) =>
        candidate.id === step.loopTargetStepId && candidate.kind !== 'trigger'
    );
    if (!loopTarget || loopTarget.dependsOn.includes(step.id)) {
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
        targetHandle: 'target',
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
  logStepId?: string | null;
  onToggleLog?: (stepId: string) => void;
  replayEnvelope?: EventEnvelope | null;
  onTriggerEvalModeChange?: (stepId: string, evalMode: PulseEvalMode) => void;
  t?: PortTranslateFn;
}): { nodes: StudioNode[]; edges: Edge[] } {
  const latest = params.latest ?? new Map<string, WorkflowStepView>();
  const noop = () => undefined;
  return {
    nodes: layoutNodes(
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
      params.onTriggerEvalModeChange
    ),
    edges: buildEdges(params.definition, latest, params.t),
  };
}
