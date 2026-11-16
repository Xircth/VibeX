import {
  fileNameForMediaUpload,
  isAttachableFile,
  mediaExtensionForMime,
  prepareMediaFileForUpload,
} from './mediaAttachments';

export function extractImageFilesFromClipboardData(
  clipboardData: DataTransfer | null | undefined
): File[] {
  if (!clipboardData) {
    return [];
  }

  const files = Array.from(clipboardData.files ?? []).filter(isAttachableFile);

  if (files.length > 0) {
    return files;
  }

  const fileItems = Array.from(clipboardData.items ?? []).filter(
    (item) => item.kind === 'file'
  );

  return fileItems
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
    .filter(isAttachableFile);
}

export function imageExtensionForMime(type: string): string {
  return mediaExtensionForMime(type);
}

export function fileNameForImageUpload(file: File): string {
  return fileNameForMediaUpload(file);
}

export function prepareImageFileForUpload(file: File): File {
  return prepareMediaFileForUpload(file);
}

export function clipboardDataHasTextPayload(
  clipboardData: DataTransfer | null | undefined
): boolean {
  if (!clipboardData) {
    return false;
  }

  return Array.from(clipboardData.types ?? []).some(
    (type) => type === 'text/plain' || type === 'text/html'
  );
}

export async function readImageFilesFromNavigatorClipboard(): Promise<File[]> {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== 'function') {
    return [];
  }

  const items = await clipboard.read();
  const files: File[] = [];

  for (const [index, item] of items.entries()) {
    const mediaType = item.types.find(
      (type) => type.startsWith('image/') || type.startsWith('video/')
    );
    if (!mediaType) {
      continue;
    }

    const blob = await item.getType(mediaType);
    const stem = mediaType.startsWith('video/')
      ? 'pasted-video'
      : 'pasted-image';
    files.push(
      new File(
        [blob],
        `${stem}-${Date.now()}-${index}.${mediaExtensionForMime(mediaType)}`,
        { type: mediaType }
      )
    );
  }

  return files;
}

export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback in insecure HTTP contexts or denied permissions.
    }
  }

  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return typeof document.execCommand === 'function'
      ? document.execCommand('copy')
      : false;
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}
