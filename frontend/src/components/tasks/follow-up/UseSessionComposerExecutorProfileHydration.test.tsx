import { renderHook } from '@testing-library/react';
import { useRef, useState, type MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ExecutorProfileId } from 'shared/types';
import { useSessionComposerExecutorProfileHydration } from './useSessionComposerExecutorProfileHydration';

const defaultProfile = {
  executor: 'codex' as const,
  variant: null,
};
const planProfile = {
  executor: 'codex' as const,
  variant: 'PLAN',
};
const scratchProfile = {
  executor: 'claude_code' as const,
  variant: 'REVIEW',
};

function renderProfileHook(
  initialProps: {
    scratchId: string | undefined;
    scratchExecutorProfile: ExecutorProfileId | null;
    defaultExecutorProfile: ExecutorProfileId | null;
    initialSelectedExecutorProfile: ExecutorProfileId | null;
    isScratchLoading: boolean;
    localMessage: string;
    saveToScratch: (
      message: string,
      executorProfileId: ExecutorProfileId | null
    ) => Promise<void>;
  }
) {
  return renderHook(
    (props: typeof initialProps) => {
      const [selectedExecutorProfile, setSelectedExecutorProfile] =
        useState<ExecutorProfileId | null>(
          props.initialSelectedExecutorProfile
        );
      const executorProfileRef =
        useRef<ExecutorProfileId | null>(null);
      const effectiveExecutorProfile =
        selectedExecutorProfile ?? props.defaultExecutorProfile;

      useSessionComposerExecutorProfileHydration({
        scratchId: props.scratchId,
        scratchExecutorProfile: props.scratchExecutorProfile,
        defaultExecutorProfile: props.defaultExecutorProfile,
        selectedExecutorProfile,
        setSelectedExecutorProfile,
        effectiveExecutorProfile,
        executorProfileRef,
        isScratchLoading: props.isScratchLoading,
        localMessage: props.localMessage,
        saveToScratch: props.saveToScratch,
      });

      return {
        selectedExecutorProfile,
        effectiveExecutorProfile,
        executorProfileRef:
          executorProfileRef as MutableRefObject<ExecutorProfileId | null>,
      };
    },
    { initialProps }
  );
}

describe('useSessionComposerExecutorProfileHydration', () => {
  it('resets missing selection to the default profile and hydrates only once per scratch id', () => {
    const saveToScratch = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderProfileHook({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: null,
      isScratchLoading: true,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(defaultProfile);

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: null,
      isScratchLoading: false,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(defaultProfile);

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: { executor: 'opencode' as const },
      initialSelectedExecutorProfile: null,
      isScratchLoading: false,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(defaultProfile);
  });

  it('preserves a selected variant while switching scratch ids during scratch loading', () => {
    const saveToScratch = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderProfileHook({
      scratchId: undefined,
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: planProfile,
      isScratchLoading: true,
      localMessage: '',
      saveToScratch,
    });

    rerender({
      scratchId: 'session-2',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: planProfile,
      isScratchLoading: true,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(planProfile);
  });

  it('applies scratch executor profiles once per scratch/profile key', () => {
    const saveToScratch = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderProfileHook({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: '',
      saveToScratch,
    });

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: scratchProfile,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(scratchProfile);

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: { ...scratchProfile },
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: '',
      saveToScratch,
    });

    expect(result.current.selectedExecutorProfile).toBe(scratchProfile);
  });

  it('syncs the latest effective profile ref and autosaves only profile key changes', () => {
    const saveToScratch = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderProfileHook({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: 'draft',
      saveToScratch,
    });

    expect(result.current.executorProfileRef.current).toBe(defaultProfile);
    expect(saveToScratch).toHaveBeenCalledWith('draft', defaultProfile);

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: null,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: 'draft changed',
      saveToScratch,
    });

    expect(saveToScratch).toHaveBeenCalledTimes(1);

    rerender({
      scratchId: 'session-1',
      scratchExecutorProfile: planProfile,
      defaultExecutorProfile: defaultProfile,
      initialSelectedExecutorProfile: defaultProfile,
      isScratchLoading: false,
      localMessage: 'draft changed',
      saveToScratch,
    });

    expect(result.current.executorProfileRef.current).toBe(planProfile);
    expect(saveToScratch).toHaveBeenLastCalledWith(
      'draft changed',
      planProfile
    );
  });
});
