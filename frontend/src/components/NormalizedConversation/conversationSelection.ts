import { markdownFromRange } from './conversationSelectionMarkdown';

export type ConversationSelection = {
  text: string;
  rect: DOMRect;
};

function selectionAncestorElement(range: Range): Element | null {
  const ancestor = range.commonAncestorContainer;
  return ancestor instanceof Element ? ancestor : ancestor.parentElement;
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

  return { text, rect };
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
