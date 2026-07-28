import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import { ScratchType } from 'shared/types';
import { useScratch } from '@/hooks/useScratch';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import {
  buildDraftFollowUpScratchUpdate,
  extractDraftFollowUpData,
  getDraftExecutorProfile,
  shouldPersistDraftFollowUp,
} from './sessionComposerDraft';

export function useSessionComposerDraftScratch({
  scratchId,
  workspaceId,
  attachedImagePaths,
  executorProfile,
  executorProfileRef,
}: {
  scratchId: string | undefined;
  workspaceId: string | null | undefined;
  attachedImagePaths: string[];
  executorProfile?: ExecutorProfileId | null;
  executorProfileRef?: RefObject<ExecutorProfileId | null>;
}) {
  const {
    scratch,
    updateScratch,
    deleteScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.DRAFT_FOLLOW_UP, scratchId ?? '');

  const scratchData = extractDraftFollowUpData(scratch);
  const scratchExecutorProfile = useMemo(
    () => getDraftExecutorProfile(scratchData),
    [scratchData]
  );

  const attachedImagePathsRef = useRef<string[]>(attachedImagePaths);
  useEffect(() => {
    attachedImagePathsRef.current = attachedImagePaths;
  }, [attachedImagePaths]);

  const latestExecutorProfileRef = useRef<ExecutorProfileId | null>(
    executorProfile ?? null
  );
  useEffect(() => {
    latestExecutorProfileRef.current = executorProfile ?? null;
  }, [executorProfile]);

  const scratchRef = useRef(scratch);
  useEffect(() => {
    scratchRef.current = scratch;
  }, [scratch]);

  const saveToScratch = useCallback(
    async (
      message: string,
      executorProfileId: ExecutorProfileId | null,
      images: string[] = attachedImagePathsRef.current
    ) => {
      if (!workspaceId) return;
      if (scratchData?.queued) return;
      if (
        !shouldPersistDraftFollowUp({
          message,
          images,
          executorProfileId,
          hasExistingScratch: !!scratchRef.current,
        })
      ) {
        return;
      }

      const update = buildDraftFollowUpScratchUpdate(
        message,
        images,
        executorProfileId,
        scratchData
      );
      if (!update) return;

      try {
        await updateScratch(update);
      } catch (e) {
        console.error('Failed to save follow-up draft', e);
      }
    },
    [scratchData, updateScratch, workspaceId]
  );

  const { debounced: setFollowUpMessage, cancel: cancelDebouncedSave } =
    useDebouncedCallback(
      useCallback(
        (value: string) =>
          saveToScratch(
            value,
            executorProfileRef?.current ?? latestExecutorProfileRef.current
          ),
        [executorProfileRef, saveToScratch]
      ),
      500
    );

  return {
    scratch,
    scratchData,
    scratchExecutorProfile,
    deleteScratch,
    isScratchLoading,
    saveToScratch,
    setFollowUpMessage,
    cancelDebouncedSave,
  };
}
