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

export function joinLocalPath(parent: string, name: string): string {
  const normalized = stripWindowsExtendedPathPrefix(parent);
  const sep =
    normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
  return `${normalized.replace(/[\\/]+$/, '')}${sep}${name}`;
}
