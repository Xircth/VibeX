export function extractImageFilesFromClipboardData(
  clipboardData: DataTransfer | null | undefined
): File[] {
  if (!clipboardData) {
    return [];
  }

  const files = Array.from(clipboardData.files ?? []).filter((file) =>
    file.type.startsWith('image/')
  );

  if (files.length > 0) {
    return files;
  }

  const imageItems = Array.from(clipboardData.items ?? []).filter(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  );

  return imageItems
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function imageExtensionForMime(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'png';
  }
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
    const imageType = item.types.find((type) => type.startsWith('image/'));
    if (!imageType) {
      continue;
    }

    const blob = await item.getType(imageType);
    files.push(
      new File(
        [blob],
        `pasted-image-${Date.now()}-${index}.${imageExtensionForMime(imageType)}`,
        { type: imageType }
      )
    );
  }

  return files;
}
