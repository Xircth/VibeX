import { tauriInvoke } from '@/lib/tauriApi';
import { isTauriDesktopShell } from '@/utils/platform';

/** Directories already handed to the webview asset protocol this session. */
const grantedDirectories = new Set<string>();

/**
 * Hands the webview asset protocol the directories an HTML preview reads its
 * relative assets from. Grants are process-global and additive inside the
 * desktop process, so a directory that was already granted is skipped.
 */
export async function allowPreviewAssetScope(
  directories: readonly string[]
): Promise<void> {
  if (!isTauriDesktopShell()) {
    return;
  }

  const pending = directories.filter(
    (directory) => !grantedDirectories.has(directory)
  );
  if (pending.length === 0) {
    return;
  }

  await tauriInvoke('allow_preview_asset_scope', { directories: pending });

  for (const directory of pending) {
    grantedDirectories.add(directory);
  }
}

/**
 * Whether every directory is already reachable, so callers can render straight
 * away instead of flashing a loading state the grant would resolve instantly.
 */
export function isPreviewAssetScopeGranted(
  directories: readonly string[]
): boolean {
  return directories.every((directory) => grantedDirectories.has(directory));
}
