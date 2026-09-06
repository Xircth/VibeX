import type { SendMessageShortcut } from 'shared/types';

export type ComposerKeyEvent = {
  key: string;
  code?: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  nativeEvent?: {
    isComposing: boolean;
    keyCode: number;
  };
};

export function isComposerEnterKey(event: {
  key: string;
  code?: string;
}): boolean {
  return (
    event.key === 'Enter' ||
    event.key === 'NumpadEnter' ||
    event.code === 'Enter' ||
    event.code === 'NumpadEnter'
  );
}

/**
 * True while an IME is converting text. Windows WebView2 reports
 * `keyCode === 229` for a physical Enter whenever an IME is installed,
 * even when `isComposing` is false — that is not composition.
 */
export function isComposerImeComposing(event: {
  key: string;
  isComposing?: boolean;
  nativeEvent?: { isComposing: boolean };
}): boolean {
  if (event.isComposing || event.nativeEvent?.isComposing) return true;
  return event.key === 'Process';
}

export function composerBareEnterInsertsNewline(
  shortcut: SendMessageShortcut | null | undefined,
  event: ComposerKeyEvent
): boolean {
  if (shortcut !== 'ModifierEnter') return false;
  if (!isComposerEnterKey(event) || event.shiftKey) return false;
  return !event.metaKey && !event.ctrlKey;
}

/**
 * Astryx only submits `key === 'Enter'` when `keyCode !== 229`.
 * Windows WebView2 + IME fails that check, so the host must submit.
 */
export function astryxHandlesComposerSubmit(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter' && event.nativeEvent?.keyCode !== 229;
}

/** Enter that follows compositionend is the IME candidate-commit key. */
export const COMPOSER_IME_COMMIT_ENTER_MS = 100;

export function isComposerImeCommitEnter(
  event: ComposerKeyEvent,
  lastCompositionEndAt: number,
  now = performance.now()
): boolean {
  if (isComposerImeComposing(event)) return true;
  if (!isComposerEnterKey(event)) return false;
  return now - lastCompositionEndAt < COMPOSER_IME_COMMIT_ENTER_MS;
}

export type ComposerEnterAction = 'submit' | 'newline' | 'defer';

export function composerEnterAction(
  shortcut: SendMessageShortcut | null | undefined,
  event: ComposerKeyEvent,
  lastCompositionEndAt = Number.NEGATIVE_INFINITY,
  now = performance.now()
): ComposerEnterAction {
  if (isComposerImeCommitEnter(event, lastCompositionEndAt, now)) {
    return 'defer';
  }
  if (!isComposerEnterKey(event) || event.shiftKey) return 'defer';
  if (composerBareEnterInsertsNewline(shortcut, event)) return 'newline';
  if (astryxHandlesComposerSubmit(event)) return 'defer';
  return 'submit';
}
