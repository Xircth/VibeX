import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import { imagesApi } from '@/lib/api';
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
  const handleAttachImages = useCallback(
    async (files: File[]) => {
      if (!workspaceId) return;

      for (const file of files) {
        try {
          const response = await imagesApi.uploadForAttempt(workspaceId, file);
          const previewUrl = URL.createObjectURL(file);

          setAttachedImages((prev) => {
            const nextApplication = getUploadedImageApplication({
              fallbackMessage: draftMessage,
              currentAttachments: prev,
              uploadResponse: response,
              previewUrl,
            });
            if (nextApplication.imageToRevoke) {
              revokeComposerImagePreviewUrl(nextApplication.imageToRevoke);
            }

            void saveToScratch(
              nextApplication.scratchMessage,
              executorProfile,
              nextApplication.scratchImagePaths
            );

            return nextApplication.attachments;
          });
        } catch (error) {
          const message =
            error instanceof Error && error.message.trim()
              ? error.message
              : 'Could not attach image';
          onError?.(message);
        }
      }
    },
    [
      draftMessage,
      executorProfile,
      onError,
      saveToScratch,
      setAttachedImages,
      workspaceId,
    ]
  );

  return { handleAttachImages };
}
