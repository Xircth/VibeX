import { act, renderHook } from '@testing-library/react';
import { type MutableRefObject, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import { useSessionComposerSessionCallbacks } from './useSessionComposerSessionCallbacks';

const planProfile = {
  executor: BaseCodingAgent.CODEX,
  variant: 'PLAN',
};

function renderSessionCallbacks({
  workspaceId = 'workspace-1',
  executorProfileRef,
  selectSession = vi.fn(),
  onSessionSelected = vi.fn(),
  onSessionCreated = vi.fn(),
}: {
  workspaceId?: string | null;
  executorProfileRef?: RefObject<ExecutorProfileId | null>;
  selectSession?: (sessionId: string) => void;
  onSessionSelected?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
} = {}) {
  const profileRef =
    executorProfileRef ??
    ({ current: null } as MutableRefObject<ExecutorProfileId | null>);
  const hook = renderHook(() =>
    useSessionComposerSessionCallbacks({
      workspaceId,
      selectSession,
      onSessionSelected,
      onSessionCreated,
      executorProfileRef: profileRef,
    })
  );

  return {
    ...hook,
    profileRef,
    selectSession,
    onSessionSelected,
    onSessionCreated,
  };
}

describe('useSessionComposerSessionCallbacks', () => {
  it('selects sessions and notifies the parent only when a workspace exists', () => {
    const { result, selectSession, onSessionSelected } =
      renderSessionCallbacks();

    act(() => {
      result.current.handleSelectSession('session-1');
    });

    expect(selectSession).toHaveBeenCalledWith('session-1');
    expect(onSessionSelected).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });

  });

  it('suppresses selected-session parent notification without workspace', () => {
    const { result, selectSession, onSessionSelected } = renderSessionCallbacks({
      workspaceId: null,
    });

    act(() => {
      result.current.handleSelectSession('session-1');
    });

    expect(selectSession).toHaveBeenCalledWith('session-1');
    expect(onSessionSelected).not.toHaveBeenCalled();
  });

  it('remembers created-session executor profile and forwards the parent callback', () => {
    const profileRef: MutableRefObject<ExecutorProfileId | null> = {
      current: null,
    };
    profileRef.current = planProfile;
    const { result, onSessionCreated } = renderSessionCallbacks({
      executorProfileRef: profileRef,
    });
    const createdSession = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    };

    act(() => {
      result.current.handleSessionCreated(createdSession);
    });

    expect(result.current.createdSessionProfiles).toEqual({
      'session-1': planProfile,
    });
    expect(onSessionCreated).toHaveBeenCalledWith(createdSession);
  });

  it('skips created-session profile memory for missing or executor-less profiles', () => {
    const profileRef: MutableRefObject<ExecutorProfileId | null> = {
      current: null,
    };
    profileRef.current = { variant: 'PLAN' } as ExecutorProfileId;
    const { result } = renderSessionCallbacks({
      executorProfileRef: profileRef,
    });

    act(() => {
      result.current.handleSessionCreated({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
      });
    });

    expect(result.current.createdSessionProfiles).toEqual({});

    profileRef.current = null;
    act(() => {
      result.current.handleSessionCreated({
        sessionId: 'session-2',
        workspaceId: 'workspace-1',
      });
    });

    expect(result.current.createdSessionProfiles).toEqual({});
  });
});
