import type { Monaco } from '@monaco-editor/react';

let monacoPromise: Promise<Monaco> | null = null;

/**
 * Start loading the bundled Monaco runtime when a preview is about to open.
 * Calls share one promise so hover, click, and editor mounts cannot race.
 */
export function preloadMonacoEditor(): Promise<Monaco> {
  monacoPromise ??= import('./monacoRuntime.local').then(
    ({ initializeLocalMonaco }) => initializeLocalMonaco()
  );
  return monacoPromise;
}
