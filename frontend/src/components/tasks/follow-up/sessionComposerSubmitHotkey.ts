import type { SendMessageShortcut } from 'shared/types';

export function composerBareEnterInsertsNewline(
  shortcut: SendMessageShortcut | null | undefined,
  event: {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  }
): boolean {
  if (shortcut !== 'ModifierEnter') return false;
  if (event.key !== 'Enter' || event.shiftKey) return false;
  return !event.metaKey && !event.ctrlKey;
}
