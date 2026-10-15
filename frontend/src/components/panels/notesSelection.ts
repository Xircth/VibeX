export type NotesSelection = {
  text: string;
  rect: DOMRect;
};

function caretRect(textarea: HTMLTextAreaElement, index: number): DOMRect {
  const host = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  mirror.style.position = 'fixed';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.left = `${host.left}px`;
  mirror.style.top = `${host.top - textarea.scrollTop}px`;
  mirror.style.width = `${host.width}px`;
  mirror.style.font = style.font;
  mirror.style.padding = style.padding;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  return rect;
}

export function notesTextareaSelection(
  textarea: HTMLTextAreaElement | null
): NotesSelection | null {
  if (!textarea) return null;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  if (start === end) return null;
  const text = textarea.value
    .slice(start, end)
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!text) return null;
  return { text, rect: caretRect(textarea, start) };
}
