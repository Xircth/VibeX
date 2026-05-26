import { useCallback, useEffect, useRef } from 'react';
import type { DragEvent } from 'react';
import {
  FILE_REFERENCE_DRAG_MIME,
  type FileReferencePayload,
} from '@/utils/fileReferences';
import {
  clearCurrentDraggedFileReference,
  getCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';

import {
  getCustomFileReferenceDropPayload,
  getFileReferenceDropPayload,
  shouldAcceptFileReferenceDrag,
} from './file-reference-drop-policy';

type UseFileReferenceDropHandlersOptions = {
  disabled: boolean;
  onInsertFileReference: (payload: FileReferencePayload | null) => void;
};

export function useFileReferenceDropHandlers({
  disabled,
  onInsertFileReference,
}: UseFileReferenceDropHandlersOptions) {
  const fileReferenceDropZoneRef = useRef<HTMLDivElement | null>(null);

  const handleDragOver = useCallback(
    (event: DragEvent) => {
      event.stopPropagation();
      if (disabled) {
        return;
      }

      if (
        shouldAcceptFileReferenceDrag({
          disabled,
          dataTransferTypes: event.dataTransfer.types,
          currentDraggedPayload: getCurrentDraggedFileReference(),
        })
      ) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    [disabled]
  );

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.stopPropagation();
      if (disabled) {
        return;
      }

      const payload = getFileReferenceDropPayload({
        disabled,
        serializedPayload: event.dataTransfer.getData(
          FILE_REFERENCE_DRAG_MIME
        ),
        currentDraggedPayload: getCurrentDraggedFileReference(),
      });
      if (!payload) {
        return;
      }

      event.preventDefault();
      onInsertFileReference(payload);
      clearCurrentDraggedFileReference();
    },
    [disabled, onInsertFileReference]
  );

  useEffect(() => {
    const dropZone = fileReferenceDropZoneRef.current;
    if (!dropZone) {
      return;
    }

    const handleCustomDrop = (event: Event) => {
      const customEvent = event as CustomEvent<FileReferencePayload | null>;
      const payload = getCustomFileReferenceDropPayload({
        disabled,
        payload: customEvent.detail,
      });
      if (!payload) return;

      onInsertFileReference(payload);
      clearCurrentDraggedFileReference();
    };

    dropZone.addEventListener(
      'vibe-file-reference-drop',
      handleCustomDrop as EventListener
    );

    return () => {
      dropZone.removeEventListener(
        'vibe-file-reference-drop',
        handleCustomDrop as EventListener
      );
    };
  }, [disabled, onInsertFileReference]);

  return {
    fileReferenceDropZoneRef,
    handleDragOver,
    handleDrop,
  };
}
