import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScratchType, type Scratch } from 'shared/types';
import { useSessionComposerDraftScratch } from './useSessionComposerDraftScratch';

const { useScratchMock, updateScratchMock, deleteScratchMock } = vi.hoisted(
  () => ({
    useScratchMock: vi.fn(),
    updateScratchMock: vi.fn(),
    deleteScratchMock: vi.fn(),
  })
);

vi.mock('@/hooks/useScratch', () => ({
  useScratch: useScratchMock,
}));

const profile = { executor: 'codex' as const };
const now = '2026-05-25T00:00:00.000Z';

function draftScratch(revision = 1, message = 'stored draft'): Scratch {
  return {
    id: 'scratch-1',
    payload: {
      type: 'DRAFT_FOLLOW_UP',
      data: {
        message,
        images: ['.vibe-images/stored.png'],
        executor_config: profile,
        queued: false,
        config_overrides: {},
      },
    },
    revision,
    created_at: now,
    updated_at: now,
  };
}

function mockScratch(scratch: Scratch | null = null) {
  useScratchMock.mockReturnValue({
    scratch,
    updateScratch: updateScratchMock,
    deleteScratch: deleteScratchMock,
    isLoading: false,
    isConnected: true,
    error: null,
  });
}

const draftArgs = {
  scratchId: 'session-1',
  workspaceId: 'workspace-1' as string | null,
  attachedImagePaths: ['.vibe-images/current.png'],
  executorProfile: profile,
  localMessage: '',
};

describe('useSessionComposerDraftScratch', () => {
  beforeEach(() => {
    vi.useRealTimers();
    useScratchMock.mockReset();
    updateScratchMock.mockReset();
    deleteScratchMock.mockReset();
    updateScratchMock.mockResolvedValue({
      kind: 'saved',
      scratch: draftScratch(2, 'hello'),
    });
    mockScratch();
  });

  it('loads draft scratch by target id and exposes draft data', () => {
    mockScratch(draftScratch());

    const { result } = renderHook(() =>
      useSessionComposerDraftScratch(draftArgs)
    );

    expect(useScratchMock).toHaveBeenCalledWith(
      ScratchType.DRAFT_FOLLOW_UP,
      'session-1'
    );
    expect(result.current.scratchData?.message).toBe('stored draft');
    expect(result.current.scratchExecutorProfile).toEqual({
      executor: 'codex' as const,
      variant: null,
      model: null,
      fast_mode: null,
      reasoning_effort: null,
    });
    expect(result.current.deleteScratch).toBe(deleteScratchMock);
  });

  it('suppresses scratch saves without workspace or persisted content', async () => {
    const { result, rerender } = renderHook(
      ({
        workspaceId,
        attachedImagePaths,
      }: {
        workspaceId: string | null;
        attachedImagePaths: string[];
      }) =>
        useSessionComposerDraftScratch({
          ...draftArgs,
          workspaceId,
          attachedImagePaths,
        }),
      {
        initialProps: {
          workspaceId: null as string | null,
          attachedImagePaths: ['.vibe-images/current.png'],
        },
      }
    );

    await act(async () => {
      await result.current.saveToScratch('hello', profile);
    });
    expect(updateScratchMock).not.toHaveBeenCalled();

    rerender({ workspaceId: 'workspace-1', attachedImagePaths: [] });
    await act(async () => {
      await result.current.saveToScratch('   ', profile);
    });
    expect(updateScratchMock).not.toHaveBeenCalled();
  });

  it('persists drafts with the latest attached image paths', async () => {
    const { result, rerender } = renderHook(
      ({ attachedImagePaths }: { attachedImagePaths: string[] }) =>
        useSessionComposerDraftScratch({
          ...draftArgs,
          attachedImagePaths,
        }),
      { initialProps: { attachedImagePaths: ['.vibe-images/old.png'] } }
    );

    rerender({ attachedImagePaths: ['.vibe-images/new.png'] });

    await act(async () => {
      await result.current.saveToScratch('hello', profile);
    });

    expect(updateScratchMock).toHaveBeenCalledWith(
      {
        payload: {
          type: 'DRAFT_FOLLOW_UP',
          data: {
            message: 'hello',
            images: ['.vibe-images/new.png'],
            executor_config: profile,
            queued: false,
            config_overrides: {},
          },
        },
      },
      { overwriteOnConflict: false }
    );
  });

  it('debounces message saves with the latest executor profile', async () => {
    vi.useFakeTimers();
    const planProfile = { executor: 'codex' as const, variant: 'PLAN' };
    const { result, rerender } = renderHook(
      ({ executorProfile }: { executorProfile: typeof profile }) =>
        useSessionComposerDraftScratch({
          ...draftArgs,
          executorProfile,
        }),
      { initialProps: { executorProfile: profile } }
    );

    rerender({ executorProfile: planProfile });
    await act(async () => {
      result.current.setFollowUpMessage('debounced');
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(updateScratchMock).toHaveBeenCalledWith(
      {
        payload: {
          type: 'DRAFT_FOLLOW_UP',
          data: {
            message: 'debounced',
            images: ['.vibe-images/current.png'],
            executor_config: planProfile,
            queued: false,
            config_overrides: {},
          },
        },
      },
      { overwriteOnConflict: false }
    );
  });

  it('persists the next composer draft even when a queued scratch flag is leftover', async () => {
    mockScratch({
      ...draftScratch(),
      payload: {
        type: 'DRAFT_FOLLOW_UP',
        data: {
          message: 'stored draft',
          images: ['.vibe-images/stored.png'],
          executor_config: profile,
          queued: true,
          config_overrides: {},
        },
      },
    });

    const { result } = renderHook(() =>
      useSessionComposerDraftScratch(draftArgs)
    );

    await act(async () => {
      await result.current.saveToScratch('next message', profile);
    });

    expect(updateScratchMock).toHaveBeenCalledWith(
      {
        payload: {
          type: 'DRAFT_FOLLOW_UP',
          data: {
            message: 'next message',
            images: ['.vibe-images/current.png'],
            executor_config: profile,
            queued: false,
            config_overrides: {},
          },
        },
      },
      { overwriteOnConflict: false }
    );
  });

  it('keeps both drafts when the server reports a revision conflict', async () => {
    const server = draftScratch(3, 'server draft');
    updateScratchMock.mockResolvedValue({
      kind: 'conflict',
      server,
    });

    const { result } = renderHook(() =>
      useSessionComposerDraftScratch({
        ...draftArgs,
        localMessage: 'mine',
      })
    );

    await act(async () => {
      await result.current.saveToScratch('mine', profile);
    });

    expect(result.current.draftConflict).toEqual(server);

    let applied: { message: string } | null = null;
    act(() => {
      applied = result.current.keepServerDraft();
    });
    expect(applied).toEqual(server.payload.data);
    expect(result.current.draftConflict).toBeNull();
  });

  it('swallows failed scratch writes after logging', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateScratchMock.mockRejectedValue(new Error('write failed'));

    const { result } = renderHook(() =>
      useSessionComposerDraftScratch({
        ...draftArgs,
        attachedImagePaths: [],
      })
    );

    await act(async () => {
      await result.current.saveToScratch('hello', profile);
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to save follow-up draft',
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});
