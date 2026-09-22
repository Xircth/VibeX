import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPromptEnhancementStoreForTests } from '@/stores/usePromptEnhancementStore';
import { useSessionComposerPromptEnhancement } from './useSessionComposerPromptEnhancement';

const { enhancePromptMock, cancelEnhancePromptMock } = vi.hoisted(() => ({
  enhancePromptMock: vi.fn(),
  cancelEnhancePromptMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  configApi: {
    enhancePrompt: enhancePromptMock,
    cancelEnhancePrompt: cancelEnhancePromptMock,
  },
}));

const contextMessages = [
  {
    role: 'user' as const,
    content: 'previous request',
    timestamp: '2026-05-25T00:00:00.000Z',
  },
];

describe('useSessionComposerPromptEnhancement', () => {
  beforeEach(() => {
    resetPromptEnhancementStoreForTests();
    enhancePromptMock.mockReset();
    cancelEnhancePromptMock.mockReset();
    cancelEnhancePromptMock.mockResolvedValue(undefined);
  });

  it('suppresses empty drafts and applies normalized enhancement results', async () => {
    const applyEnhancedPrompt = vi.fn();
    const setFollowUpError = vi.fn();
    enhancePromptMock.mockResolvedValue({
      enhancedPrompt: '  improved prompt  ',
      model: 'opencode-test',
    });

    const { result, rerender } = renderHook(
      ({ draftPrompt }: { draftPrompt: string }) =>
        useSessionComposerPromptEnhancement({
          draftPrompt,
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          contextMessages,
          applyEnhancedPrompt,
          setFollowUpError,
        }),
      { initialProps: { draftPrompt: '   ' } }
    );

    await act(async () => {
      await result.current.handleEnhancePrompt();
    });

    expect(enhancePromptMock).not.toHaveBeenCalled();

    rerender({ draftPrompt: ' improve this ' });
    await act(async () => {
      await result.current.handleEnhancePrompt();
    });

    expect(setFollowUpError).toHaveBeenCalledWith(null);
    expect(enhancePromptMock).toHaveBeenCalledWith({
      draftPrompt: ' improve this ',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      contextMessages,
    });
    expect(applyEnhancedPrompt).toHaveBeenCalledWith('improved prompt');
    expect(result.current.isEnhancingPrompt).toBe(false);
  });

  it('maps enhancement failures to follow-up errors', async () => {
    const applyEnhancedPrompt = vi.fn();
    const setFollowUpError = vi.fn();
    enhancePromptMock.mockRejectedValue(
      new Error(
        'Bad request: Prompt enhancement is disabled in system settings'
      )
    );

    const { result } = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: ' improve this ',
        sessionId: null,
        workspaceId: undefined,
        contextMessages,
        applyEnhancedPrompt,
        setFollowUpError,
      })
    );

    await act(async () => {
      await result.current.handleEnhancePrompt();
    });

    expect(enhancePromptMock).toHaveBeenCalledWith({
      draftPrompt: ' improve this ',
      sessionId: null,
      workspaceId: null,
      contextMessages,
    });
    expect(applyEnhancedPrompt).not.toHaveBeenCalled();
    expect(setFollowUpError).toHaveBeenLastCalledWith(
      'Prompt enhancement failed: disabled in system settings.'
    );
    expect(result.current.isEnhancingPrompt).toBe(false);
  });

  it('stops an in-flight enhancement and ignores its late result', async () => {
    const applyEnhancedPrompt = vi.fn();
    const setFollowUpError = vi.fn();
    let resolveEnhancement: (value: {
      enhancedPrompt: string;
      model: string;
    }) => void = () => undefined;
    enhancePromptMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnhancement = resolve;
        })
    );

    const { result } = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt,
        setFollowUpError,
      })
    );

    let enhancePromise: Promise<void> = Promise.resolve();
    await act(async () => {
      enhancePromise = result.current.handleEnhancePrompt();
    });
    expect(result.current.isEnhancingPrompt).toBe(true);

    await act(async () => {
      await result.current.handleEnhancePrompt();
    });

    expect(cancelEnhancePromptMock).toHaveBeenCalledTimes(1);
    expect(result.current.isEnhancingPrompt).toBe(false);

    await act(async () => {
      resolveEnhancement({
        enhancedPrompt: 'stale enhanced prompt',
        model: 'opencode-test',
      });
      await enhancePromise;
    });

    expect(applyEnhancedPrompt).not.toHaveBeenCalled();
    expect(setFollowUpError).toHaveBeenCalledWith(null);
    expect(setFollowUpError).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight enhancement across unmount and applies it on remount', async () => {
    let resolveEnhancement: (value: {
      enhancedPrompt: string;
      model: string;
    }) => void = () => undefined;
    enhancePromptMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnhancement = resolve;
        })
    );

    const firstApply = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: firstApply,
        setFollowUpError: vi.fn(),
      })
    );

    await act(async () => {
      void result.current.handleEnhancePrompt();
    });
    expect(result.current.isEnhancingPrompt).toBe(true);

    unmount();
    expect(cancelEnhancePromptMock).not.toHaveBeenCalled();

    const secondApply = vi.fn();
    const remounted = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: secondApply,
        setFollowUpError: vi.fn(),
      })
    );

    expect(remounted.result.current.isEnhancingPrompt).toBe(true);

    await act(async () => {
      resolveEnhancement({
        enhancedPrompt: 'kept enhanced prompt',
        model: 'opencode-test',
      });
    });

    expect(firstApply).not.toHaveBeenCalled();
    expect(secondApply).toHaveBeenCalledWith('kept enhanced prompt');
    expect(remounted.result.current.isEnhancingPrompt).toBe(false);
  });

  it('applies a finished enhancement when switching back to the session', async () => {
    let resolveEnhancement: (value: {
      enhancedPrompt: string;
      model: string;
    }) => void = () => undefined;
    enhancePromptMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnhancement = resolve;
        })
    );

    const firstApply = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: firstApply,
        setFollowUpError: vi.fn(),
      })
    );

    await act(async () => {
      void result.current.handleEnhancePrompt();
    });
    unmount();

    await act(async () => {
      resolveEnhancement({
        enhancedPrompt: 'ready when you return',
        model: 'opencode-test',
      });
    });

    const secondApply = vi.fn();
    renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: secondApply,
        setFollowUpError: vi.fn(),
      })
    );

    expect(firstApply).not.toHaveBeenCalled();
    expect(secondApply).toHaveBeenCalledWith('ready when you return');
  });

  it('does not apply a pending enhancement to a different session', async () => {
    let resolveEnhancement: (value: {
      enhancedPrompt: string;
      model: string;
    }) => void = () => undefined;
    enhancePromptMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnhancement = resolve;
        })
    );

    const { result, unmount } = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: vi.fn(),
        setFollowUpError: vi.fn(),
      })
    );

    await act(async () => {
      void result.current.handleEnhancePrompt();
    });
    unmount();

    const otherApply = vi.fn();
    const other = renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'other draft',
        sessionId: 'session-2',
        workspaceId: 'workspace-2',
        contextMessages,
        applyEnhancedPrompt: otherApply,
        setFollowUpError: vi.fn(),
      })
    );

    expect(other.result.current.isEnhancingPrompt).toBe(false);

    await act(async () => {
      resolveEnhancement({
        enhancedPrompt: 'belongs to session-1',
        model: 'opencode-test',
      });
    });

    expect(otherApply).not.toHaveBeenCalled();

    const originalApply = vi.fn();
    renderHook(() =>
      useSessionComposerPromptEnhancement({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
        applyEnhancedPrompt: originalApply,
        setFollowUpError: vi.fn(),
      })
    );

    expect(originalApply).toHaveBeenCalledWith('belongs to session-1');
  });
});
