import {
  normalizeQuoteTokenMetadata,
  type QuoteTokenMetadata,
} from '@/components/tasks/follow-up/quoteTokenMetadata';
import { markdownFromRange } from './conversationSelectionMarkdown';

export type ConversationSelection = {
  text: string;
  rect: DOMRect;
  anchor?: QuoteTokenMetadata;
};

function selectionAncestorElement(range: Range): Element | null {
  const ancestor = range.commonAncestorContainer;
  return ancestor instanceof Element ? ancestor : ancestor.parentElement;
}

function extractSelectionQuoteAnchor(
  root: HTMLElement,
  range: Range,
  ancestor: Element,
  selectedText: string
): QuoteTokenMetadata | undefined {
  const messageEl = ancestor.closest('[data-message-id]');
  const turnEl = ancestor.closest('[data-turn-id]');
  const scopedMessageEl =
    messageEl && root.contains(messageEl) ? messageEl : null;
  const scopedTurnEl = turnEl && root.contains(turnEl) ? turnEl : null;

  if (!scopedMessageEl && !scopedTurnEl) {
    return undefined;
  }

  const messageId =
    scopedMessageEl?.getAttribute('data-message-id')?.trim() || undefined;
  const turnId =
    scopedTurnEl?.getAttribute('data-turn-id')?.trim() ||
    (messageId ? messageId.split(':')[0] || messageId : undefined);

  const blockEl = ancestor.closest('[data-block-index]');
  const scopedBlockEl = blockEl && root.contains(blockEl) ? blockEl : null;
  const rawBlockIndex = scopedBlockEl?.getAttribute('data-block-index');
  const parsedBlockIndex =
    rawBlockIndex != null && rawBlockIndex !== ''
      ? Number(rawBlockIndex)
      : Number.NaN;
  const blockIndex =
    Number.isInteger(parsedBlockIndex) && parsedBlockIndex >= 0
      ? parsedBlockIndex
      : undefined;

  const anchorHost = scopedBlockEl ?? scopedMessageEl ?? scopedTurnEl;
  let utf16Offset: number | undefined;
  let prefixAnchor: string | undefined;
  let suffixAnchor: string | undefined;

  if (anchorHost) {
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(anchorHost);
      preRange.setEnd(range.startContainer, range.startOffset);
      const prefixText = preRange.toString().replace(/\u00a0/g, ' ');
      utf16Offset = prefixText.length;
      prefixAnchor = prefixText.slice(-20) || undefined;

      const fullText = (anchorHost.textContent ?? '').replace(/\u00a0/g, ' ');
      const endOffset = utf16Offset + range.toString().length;
      suffixAnchor = fullText.slice(endOffset, endOffset + 20) || undefined;
    } catch {
      const fullText = (anchorHost.textContent ?? '').replace(/\u00a0/g, ' ');
      const idx = fullText.indexOf(selectedText);
      if (idx >= 0) {
        utf16Offset = idx;
        prefixAnchor = fullText.slice(Math.max(0, idx - 20), idx) || undefined;
        suffixAnchor =
          fullText.slice(
            idx + selectedText.length,
            idx + selectedText.length + 20
          ) || undefined;
      }
    }
  }

  return normalizeQuoteTokenMetadata({
    turnId,
    messageId,
    blockIndex,
    utf16Offset,
    prefixAnchor,
    suffixAnchor,
  });
}

export function conversationSelectionInRoot(
  root: HTMLElement | null
): ConversationSelection | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const ancestor = selectionAncestorElement(range);
  if (!ancestor || !root.contains(ancestor)) return null;
  if (
    ancestor.closest(
      '[contenteditable="true"], [contenteditable="false"][role="combobox"], input, textarea'
    )
  ) {
    return null;
  }

  const text = (
    markdownFromRange(range) || selection.toString().replace(/\u00a0/g, ' ')
  ).trim();
  if (!text) return null;

  const rect =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : new DOMRect(8, 8, 1, 1);

  const anchor = extractSelectionQuoteAnchor(root, range, ancestor, text);

  return anchor ? { text, rect, anchor } : { text, rect };
}

export function conversationSelectionToolbarPosition(rect: DOMRect): {
  x: number;
  y: number;
} {
  return {
    x: rect.left + rect.width / 2,
    y: Math.max(8, rect.top - 8),
  };
}
