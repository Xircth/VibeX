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
