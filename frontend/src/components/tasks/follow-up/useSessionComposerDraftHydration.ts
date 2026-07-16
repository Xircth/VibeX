import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { DraftFollowUpData } from 'shared/types';
import { getDraftScratchHydrationDecision } from './sessionComposerDraft';
import { getAfterSendCleanup } from './sessionComposerSubmit';
import {
  imageAttachmentFromPath,
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from './sessionComposerImages';

export function useSessionComposerDraftHydration({
  scratchId,
  isScratchLoading,
  scratchData,
  setLocalMessage,
  setAttachedImages,
  setSelectedMode,
  setSelectedConfigValues,
  cancelDebouncedSave,
  deleteScratch,
}: {
  scratchId: string | undefined;
  isScratchLoading: boolean;
  scratchData: DraftFollowUpData | undefined;
  setLocalMessage: Dispatch<SetStateAction<string>>;
  setAttachedImages: Dispatch<
    SetStateAction<SessionComposerImageAttachment[]>
  >;
  /** Pending ACP session-mode state, seeded from a create-form preset. */
  setSelectedMode?: Dispatch<SetStateAction<string | null>>;
  /** Pending ACP config-option state, seeded from a create-form preset. */
  setSelectedConfigValues?: Dispatch<SetStateAction<Record<string, string>>>;
  cancelDebouncedSave: () => void;
  deleteScratch: () => Promise<void>;
}) {
  const hydratedScratchIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const hydration = getDraftScratchHydrationDecision({
      isScratchLoading,
      hydratedScratchId: hydratedScratchIdRef.current,
      scratchId,
      scratchData,
    });
    hydratedScratchIdRef.current = hydration.hydratedScratchId;
    if (!hydration.shouldHydrate) return;

    setLocalMessage(hydration.message);
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
  }, [
    isScratchLoading,
    scratchData,
    scratchId,
    setAttachedImages,
    setLocalMessage,
    setSelectedMode,
    setSelectedConfigValues,
  ]);

  const handleAfterSendCleanup = useCallback(async () => {
    cancelDebouncedSave();
    const cleanup = getAfterSendCleanup({
      attachments: [],
      scratchId,
    });
    setLocalMessage(cleanup.message);
    setAttachedImages((prev) => {
      const imageCleanup = getAfterSendCleanup({
        attachments: prev,
        scratchId,
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
    scratchId,
    setAttachedImages,
    setLocalMessage,
  ]);

  return { handleAfterSendCleanup };
}
