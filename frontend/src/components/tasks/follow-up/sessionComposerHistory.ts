const INVISIBLE_CARET_CHARS = /[\u200B\uFEFF]/g;

export type ComposerHistoryDirection = 'older' | 'newer';

export type ComposerHistoryStep = {
  index: number;
  draft: string;
  value: string;
  applied: boolean;
};

export type ComposerHistoryTurn = {
  role: string;
  blocks: ReadonlyArray<{ type: string; text?: string }>;
};

export function isComposerHistoryNavigationKey(event: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  return !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
}

export function isComposerCaretAtDocumentStart(
  editable: HTMLElement | null
): boolean {
  if (!editable) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return false;
  }

  const caret = selection.getRangeAt(0);
  const start = caret.startContainer;
  if (start !== editable && !editable.contains(start)) return false;

  const before = document.createRange();
  try {
    before.setStart(editable, 0);
    before.setEnd(start, caret.startOffset);
  } catch {
    return false;
  }

  const visible = before.toString().replace(INVISIBLE_CARET_CHARS, '');
  if (visible.length > 0) return false;

  return !before.cloneContents().querySelector('[data-astryx-token]');
}

export function shouldNavigateComposerHistory({
  key,
  isBrowsing,
  isCaretAtStart,
  historyLength,
}: {
  key: string;
  isBrowsing: boolean;
  isCaretAtStart: boolean;
  historyLength: number;
}): boolean {
  if (historyLength === 0) return false;
  if (key === 'ArrowUp') return isBrowsing || isCaretAtStart;
  if (key === 'ArrowDown') return isBrowsing;
  return false;
}

export function stepComposerHistory({
  history,
  index,
  draft,
  currentValue,
  direction,
}: {
  history: readonly string[];
  index: number;
  draft: string;
  currentValue: string;
  direction: ComposerHistoryDirection;
}): ComposerHistoryStep {
  if (history.length === 0) {
    return { index: -1, draft, value: currentValue, applied: false };
  }

  if (direction === 'older') {
    const nextDraft = index === -1 ? currentValue : draft;
    const nextIndex =
      index === -1 ? history.length - 1 : Math.max(0, index - 1);
    return {
      index: nextIndex,
      draft: nextDraft,
      value: history[nextIndex] ?? currentValue,
      applied: true,
    };
  }

  if (index === -1) {
    return { index: -1, draft, value: currentValue, applied: false };
  }

  const nextIndex = index + 1;
  if (nextIndex >= history.length) {
    return { index: -1, draft, value: draft, applied: true };
  }

  return {
    index: nextIndex,
    draft,
    value: history[nextIndex] ?? draft,
    applied: true,
  };
}

export function mergeComposerMessageHistory(
  conversationMessages: readonly string[],
  localSubmits: readonly string[]
): string[] {
  const history = conversationMessages.filter((text) => text.trim().length > 0);
  const submits = localSubmits.filter((text) => text.trim().length > 0);
  if (submits.length === 0) return history;

  let overlap = Math.min(submits.length, history.length);
  while (overlap > 0) {
    const suffix = history.slice(history.length - overlap);
    const prefix = submits.slice(0, overlap);
    if (suffix.every((item, index) => item === prefix[index])) break;
    overlap -= 1;
  }

  return history.concat(submits.slice(overlap));
}

export function composerHistoryTextFromBlocks(
  blocks: ComposerHistoryTurn['blocks']
): string {
  return blocks
    .flatMap((block) =>
      block.type === 'text' && block.text ? [block.text] : []
    )
    .join('\n\n');
}

export function composerMessageHistoryFromTurns(
  turns: readonly ComposerHistoryTurn[],
  isIgnored?: (text: string) => boolean
): string[] {
  const messages: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = composerHistoryTextFromBlocks(turn.blocks);
    if (!text.trim()) continue;
    if (isIgnored?.(text)) continue;
    messages.push(text);
  }
  return messages;
}
