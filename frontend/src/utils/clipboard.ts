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
