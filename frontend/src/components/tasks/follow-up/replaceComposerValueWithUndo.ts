/**
 * Replace contenteditable text as a single native undo unit.
 * Setting React state / `textContent` bypasses the browser undo stack.
 */
export function replaceComposerValueWithUndo(
  editor: HTMLElement,
  next: string
): boolean {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);

  const execCommand = document.execCommand?.bind(document);
  if (typeof execCommand !== 'function') return false;

  try {
    const applied =
      next.length === 0
        ? execCommand('delete')
        : execCommand('insertText', false, next);
    if (!applied) return false;
  } catch {
    return false;
  }

  try {
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: next,
        inputType: next.length === 0 ? 'deleteContent' : 'insertText',
      })
    );
  } catch {
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
