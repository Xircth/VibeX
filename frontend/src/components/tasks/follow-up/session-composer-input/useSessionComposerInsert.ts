import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent,
  type MutableRefObject,
  type RefObject,
} from 'react';
import type { ChatComposerInputHandle } from '@astryxdesign/core/Chat';
import {
  COMPOSER_IMAGE_INSERT_EVENT,
  COMPOSER_INSERT_EVENT,
  shouldAcceptComposerInsert,
  type ComposerImageInsertDetail,
  type ComposerInsertDetail,
} from '@/lib/composerInsert';
import { prepareImageFileForUpload } from '@/utils/clipboard';
import { formatFileRangeRef } from '@/utils/codeSelection';
import { clearCurrentDraggedFileReference } from '@/utils/fileReferenceDrag';
import type { FileReferencePayload } from '@/utils/fileReferences';
import {
  ANNOTATED_IMAGE_DROP_EVENT,
  clearCurrentDraggedAnnotatedImage,
  getCurrentDraggedAnnotatedImage,
  subscribeAnnotatedImageDrag,
} from '@/components/previews/imagePreviewDrag';
import { useComposerSelectionStore } from '@/stores/useComposerSelectionStore';
import { getSessionComposerStructuredTokenSegments } from '../sessionComposerStructuredTokens';
import { toSessionComposerChatToken } from '../SessionComposerStructuredText';
import { type AtReferenceMember } from '../composerAtReferences';
import {
  fileFromHostPath,
  hostPathFileName,
  isPointInElement,
  relativePathInsideRoot,
} from '../composerHostFileDrop';
import {
  attachableFilesFromFileList,
  getDroppedFileReference,
  getFileName,
  hasFileReferenceDrag,
} from './sessionComposerFiles';
import {
  fileReferenceTokenText,
  getSessionComposerEditable,
  prepareEmptyComposerForTokenInsert,
} from './sessionComposerDom';

export function useSessionComposerInsert({
  composerHandleRef,
  composerRootRef,
  dropZoneRef,
  dropActiveRef,
  value,
  onChange,
  onAttachImages,
  sessionId,
  acceptExternalInserts,
  spaceMembers,
  disabled,
  workspacePath,
  setComposerDropActive,
  lastCompositionEndAtRef,
}: {
  composerHandleRef: RefObject<ChatComposerInputHandle | null>;
  composerRootRef: RefObject<HTMLDivElement | null>;
  dropZoneRef: RefObject<HTMLDivElement | null>;
  dropActiveRef: RefObject<boolean>;
  lastCompositionEndAtRef: MutableRefObject<number>;
  value: string;
  onChange: (value: string) => void;
  onAttachImages: (files: File[]) => void;
  sessionId?: string;
  acceptExternalInserts: boolean;
  spaceMembers?: AtReferenceMember[];
  disabled: boolean;
  workspacePath?: string;
  setComposerDropActive: (active: boolean) => void;
}) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const insertComposerTokenAtCaret = useCallback(
    (token: { value: string; label: string }) => {
      const handle = composerHandleRef.current;
      if (!handle) {
        const current = valueRef.current;
        onChange(
          current.trim()
            ? `${current.trim()} ${token.value} `
            : `${token.value} `
        );
        return;
      }
      prepareEmptyComposerForTokenInsert(
        getSessionComposerEditable(composerRootRef.current)
      );
      const structured = getSessionComposerStructuredTokenSegments(
        token.value,
        { spaceMembers }
      ).find((candidate) => candidate.kind === 'token');
      handle.insertToken(
        structured?.kind === 'token'
          ? {
              ...toSessionComposerChatToken(structured.token),
              value: token.value,
            }
          : {
              value: token.value,
              label: token.label,
              variant: 'blue',
            }
      );
      onChange(handle.getValue());
    },
    [composerHandleRef, composerRootRef, onChange, spaceMembers]
  );

  const insertFileReferenceTokenAtCaret = useCallback(
    (relativePath: string) => {
      insertComposerTokenAtCaret({
        value: fileReferenceTokenText(relativePath),
        label: `@${getFileName(relativePath)}`,
      });
    },
    [insertComposerTokenAtCaret]
  );

  const insertStructuredTokenAtCaret = useCallback(
    (token: { value: string; label: string }) => {
      insertComposerTokenAtCaret({
        value: token.value,
        label: token.label,
      });
      window.requestAnimationFrame(() => composerHandleRef.current?.focus());
    },
    [composerHandleRef, insertComposerTokenAtCaret]
  );

  useEffect(() => {
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<ComposerInsertDetail>).detail;
      if (
        !shouldAcceptComposerInsert(detail, {
          conversationId: sessionId,
          acceptExternalInserts,
        })
      ) {
        return;
      }
      if (!detail || typeof detail.text !== 'string') return;
      if (detail.mode === 'token') {
        if (!detail.text) return;
        insertStructuredTokenAtCaret({
          value: detail.text,
          label: detail.label ?? detail.text,
        });
        return;
      }
      const text = detail.text.trim();
      if (!text) return;
      const current = composerHandleRef.current?.getValue() ?? valueRef.current;
      onChange(current.trim() ? `${current.trim()}\n\n${text}` : text);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => {
      window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
    };
  }, [
    acceptExternalInserts,
    composerHandleRef,
    insertStructuredTokenAtCaret,
    onChange,
    sessionId,
  ]);

  useEffect(() => {
    const onImage = (event: Event) => {
      const detail = (event as CustomEvent<ComposerImageInsertDetail>).detail;
      if (
        !detail?.file ||
        !shouldAcceptComposerInsert(
          {
            text: detail.file.name,
            conversationId: detail.conversationId,
          },
          {
            conversationId: sessionId,
            acceptExternalInserts,
          }
        )
      ) {
        return;
      }
      onAttachImages([prepareImageFileForUpload(detail.file)]);
    };
    window.addEventListener(COMPOSER_IMAGE_INSERT_EVENT, onImage);
    return () => {
      window.removeEventListener(COMPOSER_IMAGE_INSERT_EVENT, onImage);
    };
  }, [acceptExternalInserts, onAttachImages, sessionId]);

  // P2-4: consume a code selection requested from a file viewer, inserting a
  // `@path:start-end` reference at the caret (or end of input).
  const pendingComposerSelection = useComposerSelectionStore((s) => s.pending);
  const consumeComposerSelection = useComposerSelectionStore((s) => s.consume);
  useEffect(() => {
    if (!pendingComposerSelection || disabled) return;
    const consumed = consumeComposerSelection();
    if (!consumed) return;
    insertFileReferenceTokenAtCaret(
      formatFileRangeRef(
        consumed.filePath,
        consumed.startLine,
        consumed.endLine
      )
    );
    window.requestAnimationFrame(() => composerHandleRef.current?.focus());
  }, [
    composerHandleRef,
    consumeComposerSelection,
    disabled,
    insertFileReferenceTokenAtCaret,
    pendingComposerSelection,
  ]);

  const insertDroppedFileReference = useCallback(
    (payload: FileReferencePayload | null) => {
      if (!payload || disabled) return;
      insertFileReferenceTokenAtCaret(payload.relativePath);
      clearCurrentDraggedFileReference();
      window.requestAnimationFrame(() => composerHandleRef.current?.focus());
    },
    [composerHandleRef, disabled, insertFileReferenceTokenAtCaret]
  );

  const handleHostDroppedPaths = useCallback(
    async (paths: string[]) => {
      if (disabled || paths.length === 0) return;
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const files: File[] = [];
      const otherPaths: string[] = [];
      for (const path of paths) {
        if (!mountedRef.current) return;
        try {
          files.push(
            await fileFromHostPath(path, (filePath) => readFile(filePath))
          );
        } catch {
          otherPaths.push(path);
        }
      }
      if (!mountedRef.current) return;
      if (files.length > 0) {
        onAttachImages(files.map(prepareImageFileForUpload));
      }
      for (const path of otherPaths) {
        if (!mountedRef.current) return;
        const relative =
          relativePathInsideRoot(workspacePath, path) ?? hostPathFileName(path);
        if (!relative) continue;
        insertFileReferenceTokenAtCaret(relative);
      }
    },
    [disabled, insertFileReferenceTokenAtCaret, onAttachImages, workspacePath]
  );

  useEffect(() => {
    const root = composerRootRef.current;
    if (!root) return;
    const markCompositionEnd = () => {
      lastCompositionEndAtRef.current = performance.now();
    };
    root.addEventListener('compositionend', markCompositionEnd, true);
    return () => {
      root.removeEventListener('compositionend', markCompositionEnd, true);
    };
  }, [composerRootRef, lastCompositionEndAtRef]);

  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone) return;

    const handleCustomDrop = (event: Event) => {
      const customEvent = event as CustomEvent<FileReferencePayload | null>;
      insertDroppedFileReference(customEvent.detail ?? null);
    };

    dropZone.addEventListener(
      'vibe-file-reference-drop',
      handleCustomDrop as EventListener
    );

    const handleAnnotatedImageDrop = (event: Event) => {
      const file = (event as CustomEvent<File>).detail;
      if (!(file instanceof File)) {
        return;
      }
      onAttachImages([prepareImageFileForUpload(file)]);
      clearCurrentDraggedAnnotatedImage();
      setComposerDropActive(false);
    };
    dropZone.addEventListener(
      ANNOTATED_IMAGE_DROP_EVENT,
      handleAnnotatedImageDrop as EventListener
    );

    return () => {
      dropZone.removeEventListener(
        'vibe-file-reference-drop',
        handleCustomDrop as EventListener
      );
      dropZone.removeEventListener(
        ANNOTATED_IMAGE_DROP_EVENT,
        handleAnnotatedImageDrop as EventListener
      );
    };
  }, [
    dropZoneRef,
    insertDroppedFileReference,
    onAttachImages,
    setComposerDropActive,
  ]);

  useEffect(() => {
    return subscribeAnnotatedImageDrag((state) => {
      const zone = dropZoneRef.current;
      if (!state.isDragging) {
        return;
      }
      if (!zone || !state.pointer) {
        setComposerDropActive(false);
        return;
      }
      setComposerDropActive(
        isPointInElement(zone, state.pointer.x, state.pointer.y)
      );
    });
  }, [dropZoneRef, setComposerDropActive]);

  useEffect(() => {
    if (disabled) {
      setComposerDropActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          const zone = dropZoneRef.current;
          if (payload.type === 'leave') {
            setComposerDropActive(false);
            return;
          }
          if (payload.type === 'enter' || payload.type === 'over') {
            setComposerDropActive(
              !!zone &&
                'position' in payload &&
                isPointInElement(zone, payload.position.x, payload.position.y)
            );
            return;
          }
          if (payload.type !== 'drop') return;
          const overZone =
            !!zone &&
            isPointInElement(zone, payload.position.x, payload.position.y);
          const accept = overZone || dropActiveRef.current;
          setComposerDropActive(false);
          if (!accept) return;
          void handleHostDroppedPaths(payload.paths);
        })
      )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    disabled,
    dropActiveRef,
    dropZoneRef,
    handleHostDroppedPaths,
    setComposerDropActive,
  ]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      setComposerDropActive(false);
      const fileReference = getDroppedFileReference(event.dataTransfer);
      if (fileReference) {
        event.preventDefault();
        event.stopPropagation();
        insertDroppedFileReference(fileReference);
        return;
      }

      const annotatedImage = getCurrentDraggedAnnotatedImage();
      if (annotatedImage) {
        event.preventDefault();
        event.stopPropagation();
        onAttachImages([prepareImageFileForUpload(annotatedImage)]);
        clearCurrentDraggedAnnotatedImage();
        return;
      }

      const files = attachableFilesFromFileList(event.dataTransfer.files);
      if (files.length === 0) return;

      event.preventDefault();
      onAttachImages(files);
    },
    [insertDroppedFileReference, onAttachImages, setComposerDropActive]
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (hasFileReferenceDrag(event.dataTransfer)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setComposerDropActive(true);
        return;
      }
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        setComposerDropActive(true);
      }
    },
    [setComposerDropActive]
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) {
        return;
      }
      setComposerDropActive(false);
    },
    [setComposerDropActive]
  );

  return {
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
}
