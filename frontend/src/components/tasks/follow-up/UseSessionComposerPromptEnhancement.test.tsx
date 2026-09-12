import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
