import { describe, expect, it } from 'vitest';
import {
  clampContextMenuPosition,
  getContextMenuSelectedText,
  isEditableContextMenuTarget,
  isForbiddenContextMenuTarget,
} from './contextMenuHitTest';

function el(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('context menu hit test', () => {
  it('treats terminal zones as forbidden', () => {
    const terminal = el(
      '<div data-context-menu-zone="forbidden"><span>x</span></div>'
    );
    expect(isForbiddenContextMenuTarget(terminal.querySelector('span'))).toBe(
      true
    );
    expect(isEditableContextMenuTarget(terminal.querySelector('span'))).toBe(
      false
    );
  });

  it('detects inputs and contenteditable, but not monaco wrappers', () => {
    const input = el('<input />');
    expect(isEditableContextMenuTarget(input)).toBe(true);

    const editor = el(
      '<div data-context-menu-editable="ignore"><textarea></textarea></div>'
    );
    expect(isEditableContextMenuTarget(editor.querySelector('textarea'))).toBe(
      false
    );
  });

  it('reads input selection and window selection', () => {
    const input = el('<input value="hello" />') as HTMLInputElement;
    input.setSelectionRange(1, 4);
    expect(getContextMenuSelectedText(input)).toBe('ell');
  });

  it('keeps the menu inside the viewport', () => {
    expect(
      clampContextMenuPosition({
        x: 780,
        y: 580,
        menuWidth: 220,
        menuHeight: 160,
        viewportWidth: 800,
        viewportHeight: 600,
      })
    ).toEqual({ x: 572, y: 432 });
  });
});
