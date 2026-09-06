import { afterEach, describe, expect, it } from 'vitest';

import {
  composerMessageHistoryFromTurns,
  isComposerCaretAtDocumentStart,
  isComposerHistoryNavigationKey,
  mergeComposerMessageHistory,
  shouldNavigateComposerHistory,
  stepComposerHistory,
} from './sessionComposerHistory';

function mountEditor(html = ''): HTMLDivElement {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.innerHTML = html;
  document.body.appendChild(editor);
  return editor;
}

function placeCaret(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('isComposerHistoryNavigationKey', () => {
  it('accepts unmodified up and down arrows', () => {
    expect(isComposerHistoryNavigationKey({ key: 'ArrowUp' })).toBe(true);
    expect(isComposerHistoryNavigationKey({ key: 'ArrowDown' })).toBe(true);
  });

  it('ignores modified arrows and other keys', () => {
    expect(
      isComposerHistoryNavigationKey({ key: 'ArrowUp', shiftKey: true })
    ).toBe(false);
    expect(
      isComposerHistoryNavigationKey({ key: 'ArrowUp', metaKey: true })
    ).toBe(false);
    expect(isComposerHistoryNavigationKey({ key: 'ArrowLeft' })).toBe(false);
  });
});

describe('isComposerCaretAtDocumentStart', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('treats an empty editor caret as the start', () => {
    const editor = mountEditor();
    editor.focus();
    placeCaret(editor, 0);

    expect(isComposerCaretAtDocumentStart(editor)).toBe(true);
  });

  it('treats the caret before the first character as the start', () => {
    const editor = mountEditor('hello');
    const text = editor.firstChild as Text;
    placeCaret(text, 0);

    expect(isComposerCaretAtDocumentStart(editor)).toBe(true);
  });

  it('does not treat a mid-text caret as the start', () => {
    const editor = mountEditor('hello');
    const text = editor.firstChild as Text;
    placeCaret(text, 2);

    expect(isComposerCaretAtDocumentStart(editor)).toBe(false);
  });

  it('treats the caret before a leading token as the start', () => {
    const editor = mountEditor();
    const token = document.createElement('span');
    token.setAttribute('data-astryx-token', '');
    token.textContent = 'file.ts';
    editor.append(token, document.createTextNode(' more'));
    placeCaret(editor, 0);

    expect(isComposerCaretAtDocumentStart(editor)).toBe(true);
  });

  it('does not treat the caret after a leading token as the start', () => {
    const editor = mountEditor();
    const token = document.createElement('span');
    token.setAttribute('data-astryx-token', '');
    token.textContent = 'file.ts';
    const rest = document.createTextNode(' more');
    editor.append(token, rest);
    placeCaret(rest, 0);

    expect(isComposerCaretAtDocumentStart(editor)).toBe(false);
  });
});

describe('shouldNavigateComposerHistory', () => {
  it('starts recall on up only when the caret is at the start', () => {
    expect(
      shouldNavigateComposerHistory({
        key: 'ArrowUp',
        isBrowsing: false,
        isCaretAtStart: true,
        historyLength: 2,
      })
    ).toBe(true);
    expect(
      shouldNavigateComposerHistory({
        key: 'ArrowUp',
        isBrowsing: false,
        isCaretAtStart: false,
        historyLength: 2,
      })
    ).toBe(false);
  });

  it('keeps navigating while browsing so held arrows walk history', () => {
    expect(
      shouldNavigateComposerHistory({
        key: 'ArrowUp',
        isBrowsing: true,
        isCaretAtStart: false,
        historyLength: 2,
      })
    ).toBe(true);
    expect(
      shouldNavigateComposerHistory({
        key: 'ArrowDown',
        isBrowsing: true,
        isCaretAtStart: true,
        historyLength: 2,
      })
    ).toBe(true);
  });

  it('does not steal down until history recall has started', () => {
    expect(
      shouldNavigateComposerHistory({
        key: 'ArrowDown',
        isBrowsing: false,
        isCaretAtStart: false,
        historyLength: 2,
      })
    ).toBe(false);
  });
});

describe('stepComposerHistory', () => {
  const history = ['oldest', 'middle', 'newest'];

  it('saves the current draft and recalls the newest message', () => {
    expect(
      stepComposerHistory({
        history,
        index: -1,
        draft: '',
        currentValue: 'draft',
        direction: 'older',
      })
    ).toEqual({
      index: 2,
      draft: 'draft',
      value: 'newest',
      applied: true,
    });
  });

  it('walks toward older messages and stays on the oldest', () => {
    expect(
      stepComposerHistory({
        history,
        index: 2,
        draft: 'draft',
        currentValue: 'newest',
        direction: 'older',
      })
    ).toEqual({
      index: 1,
      draft: 'draft',
      value: 'middle',
      applied: true,
    });
    expect(
      stepComposerHistory({
        history,
        index: 0,
        draft: 'draft',
        currentValue: 'oldest',
        direction: 'older',
      })
    ).toEqual({
      index: 0,
      draft: 'draft',
      value: 'oldest',
      applied: true,
    });
  });

  it('restores the saved draft after the newest message', () => {
    expect(
      stepComposerHistory({
        history,
        index: 2,
        draft: 'draft',
        currentValue: 'newest',
        direction: 'newer',
      })
    ).toEqual({
      index: -1,
      draft: 'draft',
      value: 'draft',
      applied: true,
    });
  });
});

describe('mergeComposerMessageHistory', () => {
  it('appends local submits that the conversation has not caught up to', () => {
    expect(mergeComposerMessageHistory(['a', 'b'], ['b', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not duplicate submits once the conversation contains them', () => {
    expect(mergeComposerMessageHistory(['a', 'b', 'c'], ['b', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('composerMessageHistoryFromTurns', () => {
  it('keeps user text in chronological order and skips ignored prompts', () => {
    expect(
      composerMessageHistoryFromTurns(
        [
          {
            role: 'user',
            blocks: [{ type: 'text', text: 'first' }],
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', text: 'ignored assistant' }],
          },
          {
            role: 'user',
            blocks: [{ type: 'text', text: '/compact please' }],
          },
          {
            role: 'user',
            blocks: [
              { type: 'text', text: 'second' },
              { type: 'text', text: 'line' },
            ],
          },
        ],
        (text) => text.startsWith('/compact')
      )
    ).toEqual(['first', 'second\n\nline']);
  });
});
