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
  }, [
    isScratchLoading,
    scratchData,
    scratchId,
    setAttachedImages,
    setLocalMessage,
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
