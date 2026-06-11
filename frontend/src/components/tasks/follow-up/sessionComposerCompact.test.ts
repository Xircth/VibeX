import { describe, expect, it } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import {
  buildCompactContextTurnInput,
  getCompactContextErrorMessage,
  getIsCompactingContext,
  hasRunningContextCompactProcess,
  shouldClearPendingCompactProcess,
} from './sessionComposerCompact';

const profile = { executor: BaseCodingAgent.CODEX };

function processCandidate({
  id,
  prompt,
  status,
}: {
  id: string;
  prompt: string;
  status: 'running' | 'completed';
}) {
  return {
    id,
    status,
    executor_action: {
      typ: {
        type: 'CodingAgentFollowUpRequest',
        prompt,
      },
    },
  };
}

describe('session composer compact helpers', () => {
  it('builds compact turn input only when all gates are available', () => {
    expect(
      buildCompactContextTurnInput({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: profile,
        canCompact: true,
      })
    ).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: profile,
      text: '/compact',
    });

    expect(
      buildCompactContextTurnInput({
        sessionId: null,
        workspaceId: 'workspace-1',
        executorProfile: profile,
        canCompact: true,
      })
    ).toBeNull();
    expect(
      buildCompactContextTurnInput({
        sessionId: 'session-1',
        workspaceId: '',
        executorProfile: profile,
        canCompact: true,
      })
    ).toBeNull();
    expect(
      buildCompactContextTurnInput({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: null,
        canCompact: true,
      })
    ).toBeNull();
    expect(
      buildCompactContextTurnInput({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: profile,
        canCompact: false,
      })
    ).toBeNull();
  });

  it('clears pending compact state when the process appears', () => {
    expect(
      shouldClearPendingCompactProcess('process-1', [
        { id: 'other-process' },
        { id: 'process-1' },
      ])
    ).toBe(true);
    expect(
      shouldClearPendingCompactProcess('process-1', [{ id: 'other-process' }])
    ).toBe(false);
    expect(shouldClearPendingCompactProcess(null, [{ id: 'process-1' }])).toBe(
      false
    );
  });

  it('detects only running compact processes', () => {
    expect(
      hasRunningContextCompactProcess([
        processCandidate({
          id: 'process-1',
          prompt: '/compact',
          status: 'running',
        }),
      ])
    ).toBe(true);
    expect(
      hasRunningContextCompactProcess([
        processCandidate({
          id: 'process-1',
          prompt: '/compact',
          status: 'completed',
        }),
        processCandidate({
          id: 'process-2',
          prompt: 'regular follow-up',
          status: 'running',
        }),
      ])
    ).toBe(false);
  });

  it('derives compacting state from pending or running compact work', () => {
    expect(
      getIsCompactingContext({
        pendingCompactProcessId: 'process-1',
        isCompactProcessRunning: false,
      })
    ).toBe(true);

    expect(
      getIsCompactingContext({
        pendingCompactProcessId: null,
        isCompactProcessRunning: true,
      })
    ).toBe(true);

    expect(
      getIsCompactingContext({
        pendingCompactProcessId: null,
        isCompactProcessRunning: false,
      })
    ).toBe(false);
  });

  it('formats compact start errors with an unknown fallback', () => {
    expect(getCompactContextErrorMessage(new Error('network down'))).toBe(
      '启动上下文压缩失败：network down'
    );
    expect(getCompactContextErrorMessage('plain failure')).toBe(
      '启动上下文压缩失败：未知错误'
    );
  });
});
