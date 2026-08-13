import type { Monaco } from '@monaco-editor/react';

let monacoPromise: Promise<Monaco> | null = null;

/**
 * Start loading the bundled Monaco runtime before a preview panel needs it.
 * Calls share one promise so app bootstrap and editor mounts cannot race.
 */
export function preloadMonacoEditor(): Promise<Monaco> {
  monacoPromise ??= import('./monacoRuntime.local').then(
    ({ initializeLocalMonaco }) => initializeLocalMonaco()
  );
  return monacoPromise;
}
