import { describe, expect, it } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import {
  buildCompactContextTurnInput,
  getCompactContextErrorMessage,
  getIsCompactingContext,
} from './sessionComposerCompact';

const profile = { executor: BaseCodingAgent.CODEX };

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

  it('derives compacting state from pending ACP compact work', () => {
    expect(
      getIsCompactingContext({
        pendingCompactProcessId: 'process-1',
      })
    ).toBe(true);

    expect(
      getIsCompactingContext({
        pendingCompactProcessId: null,
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
