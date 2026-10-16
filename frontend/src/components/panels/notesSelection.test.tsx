import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { notesTextareaSelection } from './notesSelection';

describe('notesTextareaSelection', () => {
  it('reads the textarea range instead of the window selection', () => {
    const view = render(<textarea defaultValue="hello notes world" />);
    const textarea = view.container.querySelector('textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error('missing textarea');
    }
    textarea.focus();
    textarea.setSelectionRange(6, 11);

    expect(notesTextareaSelection(textarea)?.text).toBe('notes');
    expect(window.getSelection()?.toString() ?? '').toBe('');
  });

  it('ignores an empty or blank selection', () => {
    const view = render(<textarea defaultValue="notes" />);
    const textarea = view.container.querySelector('textarea')!;
    textarea.setSelectionRange(0, 0);
    expect(notesTextareaSelection(textarea)).toBeNull();
    textarea.value = '   ';
    textarea.setSelectionRange(0, 3);
    expect(notesTextareaSelection(textarea)).toBeNull();
    expect(notesTextareaSelection(null)).toBeNull();
  });
});
