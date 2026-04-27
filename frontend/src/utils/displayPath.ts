export function stripWindowsExtendedPathPrefix(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/i, '')
    .replace(/^\/\?\//i, '')
    .replace(/^\\\?\\/i, '');
}

export function normalizeDisplayPath(path: string | null | undefined): string {
  if (!path) {
    return '';
  }

  return stripWindowsExtendedPathPrefix(path);
}
