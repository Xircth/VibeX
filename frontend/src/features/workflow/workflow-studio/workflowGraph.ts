import { Position, type Edge } from '@xyflow/react';
import type {
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowStep,
  WorkflowStepView,
} from 'shared/types';

import { cn } from '@/lib/utils';

import type { WorkflowStudioAgentOption } from '../workflowAgent';
import { CONFIRMATION_OFFSET, type StudioMode, type StudioNode } from './types';

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

export function layoutNodes(
  definition: WorkflowDefinition,
  latest: Map<string, WorkflowStepView>,
  selectedStepId: string | null,
  mode: StudioMode,
  onSelect: (stepId: string) => void,
  events: WorkflowEventRecord[],
  agentOptions: WorkflowStudioAgentOption[],
  logStepId: string | null,
  onToggleLog: (stepId: string) => void
): StudioNode[] {
  const depths = new Map<string, number>();
  const depthOf = (step: WorkflowStep, seen = new Set<string>()): number => {
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
    return {
      id: step.id,
      type: 'workflowStep',
      position: { x: depth * 430 + 44, y: row * 160 + 76 },
      // The card has a fixed layout. Supplying its initial dimensions keeps
      // nodes visible in embedded WebViews where ResizeObserver may report a
      // frame late (React Flow hides unmeasured nodes by design).
      initialWidth: 248,
      initialHeight: 94,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      zIndex:
        selectedStepId === step.id ? 5 : logStepId === step.id ? 4 : undefined,
      handles: [
        {
          id: 'target',
          type: 'target',
          position: Position.Left,
          x: 0,
          y: 43,
          width: 8,
          height: 8,
        },
        {
          id: 'source',
          type: 'source',
          position: Position.Right,
          x: 240,
          y: 43,
          width: 8,
          height: 8,
        },
      ],
      style: { width: 248, height: 94 },
      data: {
        step,
        stepRun: latest.get(step.id),
        predecessorRuns: step.dependsOn.flatMap((id) => {
          const run = latest.get(id);
          return run ? [run] : [];
        }),
        events,
        agentOptions,
        selected: selectedStepId === step.id,
        logExpanded: logStepId === step.id,
        mode,
        onSelect,
        onToggleLog,
      },
    };
  });
  const confirmationNodes = definition.steps.flatMap((step) => {
    if (step.kind !== 'agent' || step.completionPolicy !== 'manual') return [];
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
        handles: [
          {
            id: 'target',
            type: 'target',
            position: Position.Left,
            x: 0,
            y: 20,
            width: 8,
            height: 8,
          },
          {
            id: 'source',
            type: 'source',
            position: Position.Right,
            x: 136,
            y: 20,
            width: 8,
            height: 8,
          },
        ],
        style: { width: 144, height: 48 },
        data: {
          step,
          confirmationFor: step.id,
          stepRun: latest.get(step.id),
          predecessorRuns: [],
          events,
          agentOptions,
          selected: selectedStepId === step.id,
          logExpanded: false,
          mode,
          onSelect,
          onToggleLog,
        },
      } satisfies StudioNode,
    ];
  });
  return [...stepNodes, ...confirmationNodes];
}

export function buildEdges(
  definition: WorkflowDefinition,
  latest: Map<string, WorkflowStepView>
) {
  const dependencyEdges = definition.steps.flatMap((step) =>
    step.dependsOn.map((sourceStepId) => {
      const sourceStep = definition.steps.find(
        (candidate) => candidate.id === sourceStepId
      );
      const source =
        sourceStep?.kind === 'agent' && sourceStep.completionPolicy === 'manual'
          ? `confirmation:${sourceStepId}`
          : sourceStepId;
      const sourceStatus = latest.get(sourceStepId)?.status;
      const targetStatus = latest.get(step.id)?.status;
      return {
        id: `${sourceStepId}->${step.id}`,
        source,
        target: step.id,
        sourceHandle: 'source',
        targetHandle: 'target',
        animated:
          sourceStatus === 'running' ||
          sourceStatus === 'claimed' ||
          targetStatus === 'running' ||
          targetStatus === 'claimed',
        className: cn(
          'workflow-studio-edge',
          sourceStatus === 'completed' && 'workflow-edge-completed'
        ),
      } satisfies Edge;
    })
  );
  const confirmationEdges = definition.steps.flatMap((step) =>
    step.kind === 'agent' && step.completionPolicy === 'manual'
      ? [
          {
            id: `${step.id}->confirmation:${step.id}`,
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
  return [...dependencyEdges, ...confirmationEdges];
}
