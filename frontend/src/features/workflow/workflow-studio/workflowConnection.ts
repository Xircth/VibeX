import { confirmationParentId, type StudioWorkflowStep } from './types';

export type WorkflowGraphStepLike = {
  id: string;
  dependsOn: readonly string[];
  kind?: StudioWorkflowStep['kind'];
  controlKind?: string;
};

/**
 * Returns true if adding `sourceId -> targetId` (meaning `targetId` depends on `sourceId`)
 * would introduce a directed cycle in the `dependsOn` DAG.
 * Diamond DAGs (fan-out + fan-in) return false.
 */
export function wouldCreateWorkflowCycle(
  steps: readonly WorkflowGraphStepLike[],
  sourceId: string,
  targetId: string
): boolean {
  if (sourceId === targetId) return true;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const stack = [sourceId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === targetId) {
      return true;
    }
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) continue;
    for (const upstreamId of current.dependsOn) {
      if (upstreamId === targetId) {
        return true;
      }
      if (!visited.has(upstreamId)) {
        stack.push(upstreamId);
      }
    }
  }

  return false;
}

export function isWorkflowConnectionValid(
  connection: {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
  steps?: readonly WorkflowGraphStepLike[]
): boolean {
  if (!connection.source || !connection.target) return false;
  if (connection.source === connection.target) return false;

  const sourceParent =
    confirmationParentId(connection.source) ?? connection.source;
  const targetParent =
    confirmationParentId(connection.target) ?? connection.target;

  if (
    connection.target === `confirmation:${sourceParent}` ||
    connection.source === `confirmation:${targetParent}`
  ) {
    return true;
  }

  if (sourceParent === targetParent) return false;

  if (steps) {
    const sourceStep = steps.find((step) => step.id === sourceParent);
    const targetStep = steps.find((step) => step.id === targetParent);

    if (targetStep?.kind === 'trigger') {
      return false;
    }

    if (wouldCreateWorkflowCycle(steps, sourceParent, targetParent)) {
      const isBoundedLoopBack =
        sourceStep?.kind === 'control' &&
        sourceStep.controlKind === 'bounded_loop' &&
        connection.sourceHandle === 'branch:loop_body';
      if (!isBoundedLoopBack) {
        return false;
      }
    }
  }

  return true;
}
