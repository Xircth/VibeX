import type { WorkflowDefinition } from 'shared/types';

export type WorkflowStudioAgentOption = {
  value: string;
  label: string;
  iconLight?: string | null;
  iconDark?: string | null;
  iconSvg?: string | null;
  runnable?: boolean;
};

export function isWorkflowAgentRunnable(
  option: WorkflowStudioAgentOption
): boolean {
  return option.runnable !== false;
}

export function resolveWorkflowAgentId(
  options: WorkflowStudioAgentOption[],
  preferredId?: string | null
): string {
  const runnable = options.filter(isWorkflowAgentRunnable);
  if (preferredId && runnable.some((option) => option.value === preferredId)) {
    return preferredId;
  }
  return runnable[0]?.value ?? preferredId ?? options[0]?.value ?? 'codex';
}

export function withDefaultWorkflowAgent(
  definition: WorkflowDefinition,
  agentId: string
): WorkflowDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) =>
      step.kind === 'agent' ? { ...step, agentId } : step
    ),
  };
}
