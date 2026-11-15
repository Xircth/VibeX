import {
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ExecutorProfileId } from 'shared/types';
import { imagesApi } from '@/lib/api';
import { getInvokeErrorMessage } from '@/lib/errors';
import type { SessionComposerImage } from './SessionComposerInput';
import {
  getUploadedImageApplication,
  revokeComposerImagePreviewUrl,
} from './sessionComposerImages';

export function useSessionComposerImageUpload({
  workspaceId,
  draftMessage,
  executorProfile,
  saveToScratch,
  setAttachedImages,
  onError,
}: {
  workspaceId: string | null | undefined;
  sessionId: string | null | undefined;
  draftMessage: string;
  executorProfile: ExecutorProfileId | null;
  saveToScratch: (
    message: string,
    executorProfileId: ExecutorProfileId | null,
    images?: string[]
  ) => Promise<void> | void;
  setAttachedImages: Dispatch<SetStateAction<SessionComposerImage[]>>;
  onError?: (message: string) => void;
}) {
  const latestRef = useRef({
    draftMessage,
    executorProfile,
    saveToScratch,
    onError,
  });
  latestRef.current = {
    draftMessage,
    executorProfile,
    saveToScratch,
    onError,
  };

  const handleAttachImages = useCallback(
    async (files: File[]) => {
      if (!workspaceId) return;

      for (const file of files) {
        try {
          const response = await imagesApi.uploadForAttempt(workspaceId, file);
          const previewUrl = URL.createObjectURL(file);

          setAttachedImages((prev) => {
            const {
              draftMessage: currentDraft,
              executorProfile: currentExecutorProfile,
              saveToScratch: persistScratch,
            } = latestRef.current;
            const nextApplication = getUploadedImageApplication({
              fallbackMessage: currentDraft,
              currentAttachments: prev,
              uploadResponse: response,
              previewUrl,
            });
            if (nextApplication.imageToRevoke) {
              revokeComposerImagePreviewUrl(nextApplication.imageToRevoke);
            }

            void persistScratch(
              nextApplication.scratchMessage,
              currentExecutorProfile,
              nextApplication.scratchImagePaths
            );

            return nextApplication.attachments;
          });
        } catch (error) {
          const message = getInvokeErrorMessage(error).trim();
          latestRef.current.onError?.(message || 'Could not attach file');
        }
      }
    },
    [setAttachedImages, workspaceId]
  );

  return { handleAttachImages };
}
