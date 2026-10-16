export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return true;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  return /\.[a-zA-Z0-9]{1,12}$/.test(trimmed);
}
