import { describe, expect, it, vi } from 'vitest';
import type { WorkflowEventRecord, WorkflowStepView } from 'shared/types';

import type { createWorkflowApi } from './workflowApi';
import {
  loadWorkflowEventsAfter,
  waitForWorkflowStepConversation,
} from './workflowProjection';

function event(sequence: bigint): WorkflowEventRecord {
  return {
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    eventVersion: 2n,
    eventKind: 'step_ready',
    payloadJson: '{}',
    operationId: null,
    createdAt: '2026-08-15T00:00:00Z',
  };
}

describe('loadWorkflowEventsAfter', () => {
  it('continues from the current cursor instead of replaying history', async () => {
    const events = vi
      .fn()
      .mockResolvedValueOnce([event(41n), event(42n)])
      .mockResolvedValueOnce([event(43n)]);
    const api = { events } as unknown as ReturnType<typeof createWorkflowApi>;

    await expect(
      loadWorkflowEventsAfter(api, 'run-1', 40n, 2)
    ).resolves.toEqual([event(41n), event(42n), event(43n)]);
    expect(events).toHaveBeenNthCalledWith(1, 'run-1', 40, 2);
    expect(events).toHaveBeenNthCalledWith(2, 'run-1', 42, 2);
  });
});

describe('waitForWorkflowStepConversation', () => {
  it('waits for the native child Conversation before follow-up input', async () => {
    const running = {
      stepId: 'review',
      attempt: 1n,
      status: 'running',
      conversationId: 'conversation-1',
    } as WorkflowStepView;
    const steps = vi
      .fn()
      .mockResolvedValueOnce([
        { ...running, status: 'ready', conversationId: null },
      ])
      .mockResolvedValueOnce([running]);
    const api = { steps } as unknown as ReturnType<typeof createWorkflowApi>;
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForWorkflowStepConversation(api, 'run-1', 'review', {
        timeoutMs: 1_000,
        delay,
      })
    ).resolves.toBe(running);
    expect(delay).toHaveBeenCalledOnce();
  });

  it('fails visibly when dispatch terminates before opening a Conversation', async () => {
    const api = {
      steps: vi.fn().mockResolvedValue([
        {
          stepId: 'review',
          attempt: 1n,
          status: 'failed',
          conversationId: null,
        },
      ]),
    } as unknown as ReturnType<typeof createWorkflowApi>;

    await expect(
      waitForWorkflowStepConversation(api, 'run-1', 'review')
    ).rejects.toThrow('became failed');
  });
});
