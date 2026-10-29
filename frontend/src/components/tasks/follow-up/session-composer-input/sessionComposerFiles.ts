import {
  extractImageFilesFromClipboardData,
  prepareImageFileForUpload,
  readImageFilesFromNavigatorClipboard,
} from '@/utils/clipboard';
import { isAttachableFile } from '@/utils/mediaAttachments';
import {
  FILE_REFERENCE_DRAG_MIME,
  parseFileReferencePayload,
  type FileReferencePayload,
} from '@/utils/fileReferences';
import { getCurrentDraggedFileReference } from '@/utils/fileReferenceDrag';

export function attachableFilesFromFileList(
  files: FileList | null | undefined
): File[] {
  return Array.from(files ?? [])
    .filter(isAttachableFile)
    .map(prepareImageFileForUpload);
}

/**
 * Paste handler for screenshots and other attached files. Astryx reads
 * `clipboardData.files` before calling this prop, so file payloads usually
 * arrive here either as clipboard *items* (recovered synchronously) or
 * through the async `navigator.clipboard.read()` fallback (e.g. an image
 * copied off a webpage). Returns `true` when a file was handed to
 * `onAttachImages`, telling Astryx to skip its default text insert;
 * plain-text and empty pastes return `false` so normal composer behavior is
 * untouched.
 */
export function handleComposerImagePaste(
  event: { clipboardData: DataTransfer | null },
  onAttachImages: (files: File[]) => void,
  disabled = false
): boolean {
  if (disabled) {
    return false;
  }
  const files = extractImageFilesFromClipboardData(event.clipboardData);
  if (files.length > 0) {
    onAttachImages(files.map(prepareImageFileForUpload));
    return true;
  }
  void readImageFilesFromNavigatorClipboard()
    .then((fallbackFiles) => {
      if (fallbackFiles.length > 0) {
        onAttachImages(fallbackFiles.map(prepareImageFileForUpload));
      }
    })
    .catch(() => undefined);
  return false;
}

export function getDroppedFileReference(
  dataTransfer: DataTransfer
): FileReferencePayload | null {
  const serializedPayload = dataTransfer.getData(FILE_REFERENCE_DRAG_MIME);
  return (
    parseFileReferencePayload(serializedPayload) ??
    getCurrentDraggedFileReference()
  );
}

export function hasFileReferenceDrag(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes(FILE_REFERENCE_DRAG_MIME) ||
    Boolean(getCurrentDraggedFileReference())
  );
}

export function getFileName(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
