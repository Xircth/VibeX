import { describe, expect, it } from 'vitest';
import {
  conversationSelectionInRoot,
  conversationSelectionToolbarPosition,
} from './conversationSelection';

describe('conversationSelectionInRoot', () => {
  it('returns trimmed selected text inside the conversation root', () => {
    const root = document.createElement('div');
    const message = document.createElement('p');
    message.textContent = '请你帮我完成这次修改';
    root.append(message);
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(message);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(conversationSelectionInRoot(root)).toEqual(
      expect.objectContaining({
        text: '请你帮我完成这次修改',
      })
    );

    selection?.removeAllRanges();
    root.remove();
  });

  it('ignores selections outside the conversation root', () => {
    const root = document.createElement('div');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(root, outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(conversationSelectionInRoot(root)).toBeNull();

    selection?.removeAllRanges();
    root.remove();
    outside.remove();
  });

  it('places the toolbar above the selection midpoint', () => {
    expect(
      conversationSelectionToolbarPosition(new DOMRect(40, 80, 120, 20))
    ).toEqual({
      x: 100,
      y: 72,
    });
  });
});
