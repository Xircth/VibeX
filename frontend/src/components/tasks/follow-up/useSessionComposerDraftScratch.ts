import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { ExecutorProfileId, Scratch } from 'shared/types';
import { ScratchType } from 'shared/types';
import { useScratch } from '@/hooks/useScratch';
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback';
import {
  buildDraftFollowUpScratchUpdate,
  draftFollowUpContentsEqual,
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
  localMessage,
}: {
  scratchId: string | undefined;
  workspaceId: string | null | undefined;
  attachedImagePaths: string[];
  executorProfile?: ExecutorProfileId | null;
  executorProfileRef?: RefObject<ExecutorProfileId | null>;
  localMessage: string;
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
  const lastSeenRevisionRef = useRef<number | null>(scratch?.revision ?? null);
  const [lastSavedRevision, setLastSavedRevision] = useState<number | null>(
    scratch?.revision ?? null
  );
  const [conflict, setConflict] = useState<Scratch | null>(null);

  const rememberRevision = (revision: number) => {
    lastSavedRevisionRef.current = revision;
    lastSeenRevisionRef.current = revision;
    setLastSavedRevision(revision);
  };

  useEffect(() => {
    if (!scratch) {
      lastSeenRevisionRef.current = null;
      return;
    }
    if (lastSeenRevisionRef.current == null) {
      rememberRevision(scratch.revision);
      return;
    }
    if (scratch.revision === lastSeenRevisionRef.current) return;
    lastSeenRevisionRef.current = scratch.revision;
    const server = extractDraftFollowUpData(scratch);
    if (
      !draftFollowUpContentsEqual(server, {
        message: localMessage,
        images: attachedImagePathsRef.current,
      })
    ) {
      setConflict(scratch);
    }
  }, [localMessage, scratch]);

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

      try {
        const outcome = await updateScratch(update, {
          overwriteOnConflict: false,
        });
        if (outcome.kind === 'conflict') {
          setConflict(outcome.server);
          return;
        }
        rememberRevision(outcome.scratch.revision);
        setConflict(null);
      } catch (e) {
        console.error('Failed to save follow-up draft', e);
      }
    },
    [scratchData, updateScratch, workspaceId]
  );

  const keepServerDraft = useCallback(() => {
    if (!conflict) return null;
    rememberRevision(conflict.revision);
    const data = extractDraftFollowUpData(conflict);
    setConflict(null);
    return data ?? null;
  }, [conflict]);

  const keepLocalDraft = useCallback(async () => {
    if (!conflict) return;
    const executorProfileId =
      executorProfileRef?.current ?? latestExecutorProfileRef.current;
    const update = buildDraftFollowUpScratchUpdate(
      localMessage,
      attachedImagePathsRef.current,
      executorProfileId,
      scratchData
    );
    if (!update) return;
    const outcome = await updateScratch(
      {
        ...update,
        expected_revision: conflict.revision,
      },
      { overwriteOnConflict: false }
    );
    if (outcome.kind === 'conflict') {
      setConflict(outcome.server);
      return;
    }
    rememberRevision(outcome.scratch.revision);
    setConflict(null);
  }, [conflict, executorProfileRef, localMessage, scratchData, updateScratch]);

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

  return {
    scratch,
    scratchData,
    scratchExecutorProfile,
    deleteScratch,
    isScratchLoading,
    saveToScratch,
    setFollowUpMessage,
    cancelDebouncedSave,
    draftConflict: conflict,
    keepServerDraft,
    keepLocalDraft,
    lastSavedRevision,
    scratchRevision: scratch?.revision ?? null,
  };
}
