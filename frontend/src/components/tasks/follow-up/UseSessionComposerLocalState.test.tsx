import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import {
  useSessionComposerLocalState,
  useSessionComposerProfileSelection,
} from './useSessionComposerLocalState';

const codexProfile: ExecutorProfileId = { executor: BaseCodingAgent.CODEX };
const claudeProfile: ExecutorProfileId = {
  executor: BaseCodingAgent.CLAUDE_CODE,
};
type ProfileProps = { defaultProfile: ExecutorProfileId | null };

describe('useSessionComposerLocalState', () => {
  it('starts with empty draft and attachments', () => {
    const { result } = renderHook(() => useSessionComposerLocalState());

    expect(result.current.localMessage).toBe('');
    expect(result.current.attachedImages).toEqual([]);
    expect(result.current.attachedImagePaths).toEqual([]);
    expect(result.current.executorProfileRef.current).toBeNull();
  });

  it('derives image paths from attached image state', () => {
    const { result } = renderHook(() => useSessionComposerLocalState());

    act(() => {
      result.current.setAttachedImages([
        {
          id: 'image-1',
          name: 'first.png',
          path: 'vibe://image/first.png',
        },
        {
          id: 'image-2',
          name: 'second.png',
          path: 'vibe://image/second.png',
        },
      ]);
    });

    expect(result.current.attachedImagePaths).toEqual([
      'vibe://image/first.png',
      'vibe://image/second.png',
    ]);
  });

  it('keeps an explicit selected executor profile across default changes', () => {
    const initialProps: ProfileProps = { defaultProfile: codexProfile };
    const { result, rerender } = renderHook(
      ({ defaultProfile }: ProfileProps) =>
        useSessionComposerProfileSelection(defaultProfile),
      { initialProps }
    );

    act(() => {
      result.current.setSelectedExecutorProfile(claudeProfile);
    });

    rerender({ defaultProfile: null });

    expect(result.current.selectedExecutorProfile).toEqual(claudeProfile);
    expect(result.current.effectiveExecutorProfile).toEqual(claudeProfile);
  });

  it('falls back to the latest default when no profile is selected', () => {
    const initialProps: ProfileProps = { defaultProfile: codexProfile };
    const { result, rerender } = renderHook(
      ({ defaultProfile }: ProfileProps) =>
        useSessionComposerProfileSelection(defaultProfile),
      { initialProps }
    );

    act(() => {
      result.current.setSelectedExecutorProfile(null);
    });

    rerender({ defaultProfile: claudeProfile });

    expect(result.current.selectedExecutorProfile).toBeNull();
    expect(result.current.effectiveExecutorProfile).toEqual(claudeProfile);
  });
});
