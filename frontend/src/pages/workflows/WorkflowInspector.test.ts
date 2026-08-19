import { describe, expect, it } from 'vitest';
import type { WorkflowStepView } from 'shared/types';

import { workflowProgress } from '@/features/workflow/workflowProjection';
import { isWorkflowTerminal } from './WorkflowInspector';

function step(
  status: string,
  stepId: string = crypto.randomUUID(),
  attempt = 1n
): WorkflowStepView {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId,
    attempt,
    status,
    conversationId: null,
    turnId: null,
    outputJson: null,
    outputSchemaDigest: null,
    candidateOutputJson: null,
    candidateSchemaDigest: null,
    awaitingAcceptance: false,
    awaitingInput: false,
    executionMode: 'normal',
    resolvedInputJson: null,
    resolvedInputDigest: null,
    executionEvidenceJson: null,
    workspaceId: null,
    waitingInteraction: false,
    repairCount: 0n,
    claimToken: null,
    claimDeadline: null,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

describe('workflow inspector projection', () => {
  it('counts only accepted terminal step outcomes as progress', () => {
    expect(
      workflowProgress([
        step('completed'),
        step('skipped'),
        step('failed'),
        step('running'),
      ])
    ).toEqual({ done: 2, total: 4, percent: 50 });
  });

  it('counts the latest attempt once instead of treating retries as new steps', () => {
    expect(
      workflowProgress([
        step('failed', 'research', 1n),
        step('completed', 'research', 2n),
        step('running', 'write', 1n),
      ])
    ).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it('keeps needs-review runs live for an explicit decision', () => {
    expect(isWorkflowTerminal('completed')).toBe(true);
    expect(isWorkflowTerminal('cancelled')).toBe(true);
    expect(isWorkflowTerminal('needs_review')).toBe(false);
    expect(isWorkflowTerminal('waiting')).toBe(false);
  });
});
