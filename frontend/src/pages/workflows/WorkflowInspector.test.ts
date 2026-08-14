import { describe, expect, it } from 'vitest';
import type { WorkflowStepView } from 'shared/types';

import { isWorkflowTerminal, workflowProgress } from './WorkflowInspector';

function step(status: string): WorkflowStepView {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
    attempt: 1n,
    status,
    conversationId: null,
    turnId: null,
    outputJson: null,
    outputSchemaDigest: null,
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

  it('keeps needs-review runs live for an explicit decision', () => {
    expect(isWorkflowTerminal('completed')).toBe(true);
    expect(isWorkflowTerminal('cancelled')).toBe(true);
    expect(isWorkflowTerminal('needs_review')).toBe(false);
    expect(isWorkflowTerminal('waiting')).toBe(false);
  });
});
