import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { ExecutorProfileId } from 'shared/types';
import type { SessionComposerImage } from './SessionComposerInput';
import {
  removeComposerImageAttachment,
  revokeComposerImagePreviewUrl,
} from './sessionComposerImages';

export function useSessionComposerImageRemoval({
  draftMessage,
  executorProfileRef,
  saveToScratch,
  setAttachedImages,
}: {
  draftMessage: string;
  executorProfileRef: RefObject<ExecutorProfileId | null>;
  saveToScratch: (
    message: string,
    executorProfileId: ExecutorProfileId | null,
    images?: string[]
  ) => Promise<void> | void;
  setAttachedImages: Dispatch<SetStateAction<SessionComposerImage[]>>;
}) {
  const handleRemoveImage = useCallback(
    (imageId: string) => {
      setAttachedImages((prev) => {
        const { attachments: next, imagesToRevoke } =
          removeComposerImageAttachment(prev, imageId);
        imagesToRevoke.forEach(revokeComposerImagePreviewUrl);
        void saveToScratch(
          draftMessage,
          executorProfileRef.current,
          next.map((image) => image.path)
        );
        return next;
      });
    },
    [draftMessage, executorProfileRef, saveToScratch, setAttachedImages]
  );

  return { handleRemoveImage };
}
