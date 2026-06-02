import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExecutorProfileId, QueueStatus } from 'shared/types';
import { imagesApi } from '@/lib/api';
import type { SessionComposerImage } from './SessionComposerInput';
import {
  getUploadedImageApplication,
  revokeComposerImagePreviewUrl,
} from './sessionComposerImages';
import { getQueueSnapshot, getQueueStatusQueryKey } from './sessionComposerQueue';

export function useSessionComposerImageUpload({
  workspaceId,
  sessionId,
  draftMessage,
  executorProfile,
  saveToScratch,
  setAttachedImages,
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
}) {
  const queryClient = useQueryClient();

  const handleAttachImages = useCallback(
    async (files: File[]) => {
      if (!workspaceId) return;

      for (const file of files) {
        try {
          const response = await imagesApi.uploadForAttempt(workspaceId, file);
          const status = queryClient.getQueryData<QueueStatus>(
            getQueueStatusQueryKey(sessionId ?? undefined)
          );
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

            if (!getQueueSnapshot(status).isQueued) {
              void saveToScratch(
                nextApplication.scratchMessage,
                executorProfile,
                nextApplication.scratchImagePaths
              );
            }

            return nextApplication.attachments;
          });
        } catch (error) {
          console.error('Failed to upload image:', error);
        }
      }
    },
    [
      draftMessage,
      executorProfile,
      queryClient,
      saveToScratch,
      sessionId,
      setAttachedImages,
      workspaceId,
    ]
  );

  return { handleAttachImages };
}
