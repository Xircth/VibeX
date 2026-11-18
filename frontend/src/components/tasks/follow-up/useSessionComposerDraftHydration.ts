import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { DraftFollowUpData } from 'shared/types';
import {
  draftRepeatsQueuedMessage,
  getDraftScratchHydrationDecision,
  getQueuedDraftEchoSuppression,
} from './sessionComposerDraft';
import { getAfterSendCleanup } from './sessionComposerSubmit';
import {
  imageAttachmentFromPath,
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from './sessionComposerImages';

const NO_QUEUED_MESSAGES: readonly string[] = [];

export function useSessionComposerDraftHydration({
  scratchId,
  isScratchLoading,
  scratchData,
  localMessage,
  setLocalMessage,
  setAttachedImages,
  setSelectedMode,
  setSelectedConfigValues,
  cancelDebouncedSave,
  deleteScratch,
  savedRevision,
  serverRevision,
  queuedMessageTexts = NO_QUEUED_MESSAGES,
  isEditingQueued = false,
  onQueuedDraftSuppressed,
}: {
  scratchId: string | undefined;
  isScratchLoading: boolean;
  scratchData: DraftFollowUpData | undefined;
  localMessage?: string;
  setLocalMessage: Dispatch<SetStateAction<string>>;
  setAttachedImages: Dispatch<SetStateAction<SessionComposerImageAttachment[]>>;
  /** Pending ACP session-mode state, seeded from a create-form preset. */
  setSelectedMode?: Dispatch<SetStateAction<string | null>>;
  /** Pending ACP config-option state, seeded from a create-form preset. */
  setSelectedConfigValues?: Dispatch<SetStateAction<Record<string, string>>>;
  cancelDebouncedSave: () => void;
  deleteScratch: () => Promise<void>;
  savedRevision?: number | null;
  serverRevision?: number | null;
  queuedMessageTexts?: readonly string[];
  isEditingQueued?: boolean;
  onQueuedDraftSuppressed?: () => void;
}) {
  const hydratedScratchIdRef = useRef<string | undefined>(undefined);
  const hydratedEchoRef = useRef('');
  const userEditedRef = useRef(false);
  const suppressedEchoRef = useRef<string | null>(null);
  const queuedDraftSuppressedRef = useRef(onQueuedDraftSuppressed);
  queuedDraftSuppressedRef.current = onQueuedDraftSuppressed;

  useEffect(() => {
    if (
      hydratedScratchIdRef.current &&
      hydratedScratchIdRef.current !== scratchId
    ) {
      hydratedEchoRef.current = '';
      userEditedRef.current = false;
      suppressedEchoRef.current = null;
    }
    const hydration = getDraftScratchHydrationDecision({
      isScratchLoading,
      hydratedScratchId: hydratedScratchIdRef.current,
      scratchId,
      scratchData,
      localMessage,
      queuedMessageTexts,
    });
    hydratedScratchIdRef.current = hydration.hydratedScratchId;
    if (!hydration.shouldHydrate) return;

    hydratedEchoRef.current = hydration.message ?? '';
    userEditedRef.current = false;
    suppressedEchoRef.current = null;
    setLocalMessage(hydration.message ?? '');
    setAttachedImages((prev) => {
      prev.forEach(revokeComposerImagePreviewUrl);
      return hydration.imagePaths.map(imageAttachmentFromPath);
    });
    if (hydration.modeOverride !== null) {
      setSelectedMode?.(hydration.modeOverride);
    }
    if (Object.keys(hydration.configOverrides).length > 0) {
      setSelectedConfigValues?.(hydration.configOverrides);
    }
    const scratchMessage =
      typeof scratchData?.message === 'string' ? scratchData.message : '';
    if (draftRepeatsQueuedMessage(scratchMessage, queuedMessageTexts)) {
      queuedDraftSuppressedRef.current?.();
    }
  }, [
    isScratchLoading,
    localMessage,
    queuedMessageTexts,
    scratchData,
    scratchId,
    setAttachedImages,
    setLocalMessage,
    setSelectedMode,
    setSelectedConfigValues,
  ]);

  useEffect(() => {
    const decision = getQueuedDraftEchoSuppression({
      isEditingQueued,
      userEdited: userEditedRef.current,
      hydratedEcho: hydratedEchoRef.current,
      localMessage: localMessage ?? '',
      queuedMessageTexts,
      alreadySuppressedEcho: suppressedEchoRef.current,
    });
    userEditedRef.current = decision.userEdited;
    if (!decision.suppress) return;
    const echo = hydratedEchoRef.current.trim();
    suppressedEchoRef.current = echo;
    hydratedEchoRef.current = '';
    setLocalMessage('');
    setAttachedImages((prev) => {
      prev.forEach(revokeComposerImagePreviewUrl);
      return [];
    });
    queuedDraftSuppressedRef.current?.();
  }, [
    isEditingQueued,
    localMessage,
    queuedMessageTexts,
    setAttachedImages,
    setLocalMessage,
  ]);

  const handleAfterSendCleanup = useCallback(async () => {
    cancelDebouncedSave();
    const cleanup = getAfterSendCleanup({
      attachments: [],
      scratchId,
      savedRevision,
      serverRevision,
    });
    setLocalMessage(cleanup.message);
    setAttachedImages((prev) => {
      const imageCleanup = getAfterSendCleanup({
        attachments: prev,
        scratchId,
        savedRevision,
        serverRevision,
      });
      imageCleanup.imagesToRevoke.forEach(revokeComposerImagePreviewUrl);
      return imageCleanup.attachments;
    });
    hydratedScratchIdRef.current = cleanup.hydratedScratchId;
    if (cleanup.shouldDeleteScratch) {
      await deleteScratch();
    }
  }, [
    cancelDebouncedSave,
    deleteScratch,
    savedRevision,
    scratchId,
    serverRevision,
    setAttachedImages,
    setLocalMessage,
  ]);

  return { handleAfterSendCleanup };
}
