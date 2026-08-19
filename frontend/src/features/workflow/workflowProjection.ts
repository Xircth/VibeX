import type { WorkflowEventRecord, WorkflowStepView } from 'shared/types';
import type { createWorkflowApi } from './workflowApi';

const DONE_STEP_STATUSES = new Set(['completed', 'skipped']);

export function latestWorkflowStepAttempts(steps: WorkflowStepView[]) {
  const latest = new Map<string, WorkflowStepView>();
  for (const step of steps) {
    const current = latest.get(step.stepId);
    if (!current || step.attempt > current.attempt)
      latest.set(step.stepId, step);
  }
  return [...latest.values()];
}

export function workflowProgress(steps: WorkflowStepView[]) {
  const latest = latestWorkflowStepAttempts(steps);
  const done = latest.filter((step) =>
    DONE_STEP_STATUSES.has(step.status)
  ).length;
  return {
    done,
    total: latest.length,
    percent: latest.length === 0 ? 0 : Math.round((done / latest.length) * 100),
  };
}

export async function loadAllWorkflowEvents(
  api: ReturnType<typeof createWorkflowApi>,
  runId: string,
  pageSize = 500
): Promise<WorkflowEventRecord[]> {
  return loadWorkflowEventsAfter(api, runId, 0n, pageSize);
}

export async function loadWorkflowEventsAfter(
  api: ReturnType<typeof createWorkflowApi>,
  runId: string,
  afterSequence: bigint,
  pageSize = 500
): Promise<WorkflowEventRecord[]> {
  const events: WorkflowEventRecord[] = [];
  let cursor = afterSequence;
  for (;;) {
    const page = await api.events(runId, Number(cursor), pageSize);
    events.push(...page);
    if (page.length < pageSize) return events;
    const next = page.at(-1)?.sequence ?? cursor;
    if (next <= cursor) return events;
    cursor = next;
  }
}

const TERMINAL_STEP_STATUSES = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
  'needs_review',
]);

export async function waitForWorkflowStepConversation(
  api: ReturnType<typeof createWorkflowApi>,
  runId: string,
  stepId: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<WorkflowStepView> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const step = latestWorkflowStepAttempts(await api.steps(runId)).find(
      (candidate) => candidate.stepId === stepId
    );
    if (step?.conversationId) return step;
    if (step && TERMINAL_STEP_STATUSES.has(step.status)) {
      throw new Error(
        `Workflow step ${stepId} became ${step.status} before its conversation opened`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Workflow step ${stepId} is still waiting for its prerequisites`
      );
    }
    await delay(pollIntervalMs);
  }
}
