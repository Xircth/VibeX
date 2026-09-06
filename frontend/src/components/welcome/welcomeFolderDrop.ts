export function droppedFolderPath(paths: string[]): string | null {
  if (paths.length !== 1) return null;
  const path = paths[0]?.trim() ?? '';
  return path.length > 0 ? path : null;
}

export async function resolveDroppedProjectFolder(
  paths: string[],
  listDirectory: (path: string) => Promise<unknown>
): Promise<{ ok: true; path: string } | { ok: false; reason: 'invalid' }> {
  const path = droppedFolderPath(paths);
  if (!path) return { ok: false, reason: 'invalid' };
  try {
    await listDirectory(path);
    return { ok: true, path };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
