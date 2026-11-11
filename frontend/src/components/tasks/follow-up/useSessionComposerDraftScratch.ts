import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
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
  localMessage?: string;
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

  const lastSavedRevisionRef = useRef<number | null>(scratch?.revision ?? null);
  const saveGenerationRef = useRef(0);
  const cancelDebouncedSaveRef = useRef(() => {});
  const [lastSavedRevision, setLastSavedRevision] = useState<number | null>(
    scratch?.revision ?? null
  );

  const rememberRevision = (revision: number) => {
    lastSavedRevisionRef.current = revision;
    setLastSavedRevision(revision);
  };

  const discardInFlightSaves = () => {
    saveGenerationRef.current += 1;
    cancelDebouncedSaveRef.current();
  };

  const activeScratchIdRef = useRef(scratchId);
  useEffect(() => {
    if (activeScratchIdRef.current === scratchId) return;
    activeScratchIdRef.current = scratchId;
    saveGenerationRef.current += 1;
    cancelDebouncedSaveRef.current();
    lastSavedRevisionRef.current = null;
    setLastSavedRevision(null);
  }, [scratchId]);

  useEffect(() => {
    if (!scratch) {
      lastSavedRevisionRef.current = null;
      setLastSavedRevision(null);
      return;
    }
    if (
      lastSavedRevisionRef.current == null ||
      scratch.revision > lastSavedRevisionRef.current
    ) {
      rememberRevision(scratch.revision);
    }
  }, [scratch]);

  const saveToScratch = useCallback(
    async (
      message: string,
      executorProfileId: ExecutorProfileId | null,
      images: string[] = attachedImagePathsRef.current
    ) => {
      if (!workspaceId) return;
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

      const generation = saveGenerationRef.current;
      try {
        const outcome = await updateScratch({
          ...update,
          expected_revision:
            lastSavedRevisionRef.current ?? scratchRef.current?.revision ?? 0,
        });
        if (generation !== saveGenerationRef.current) return;
        if (outcome.kind === 'saved') {
          rememberRevision(outcome.scratch.revision);
        } else {
          rememberRevision(outcome.server.revision);
        }
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
          void saveToScratch(
            value,
            executorProfileRef?.current ?? latestExecutorProfileRef.current
          ),
        [executorProfileRef, saveToScratch]
      ),
      500
    );
  const cancelPendingDraftWrites = useCallback(() => {
    discardInFlightSaves();
  }, []);
  cancelDebouncedSaveRef.current = cancelDebouncedSave;

  return {
    scratch,
    scratchData,
    scratchExecutorProfile,
    deleteScratch,
    isScratchLoading,
    saveToScratch,
    setFollowUpMessage,
    cancelDebouncedSave: cancelPendingDraftWrites,
    lastSavedRevision,
    scratchRevision: scratch?.revision ?? null,
  };
}

