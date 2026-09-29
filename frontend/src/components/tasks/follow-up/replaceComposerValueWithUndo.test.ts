import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  insertComposerTextWithUndo,
  replaceComposerValueWithUndo,
} from './replaceComposerValueWithUndo';

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: execCommand,
  });
  return execCommand;
}

describe('insertComposerTextWithUndo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('inserts through execCommand so native undo can restore the pre-paste text', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'hello';
    document.body.append(editor);
    const execCommand = stubExecCommand(true);

    expect(insertComposerTextWithUndo(editor, ' world')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, ' world');
  });

  it('does not insert an empty clipboard payload', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    const execCommand = stubExecCommand(true);

    expect(insertComposerTextWithUndo(editor, '')).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe('replaceComposerValueWithUndo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('selects the current contents and inserts through execCommand', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'original prompt';
    document.body.append(editor);
    const execCommand = stubExecCommand(true);
    const onInput = vi.fn();
    editor.addEventListener('input', onInput);

    expect(replaceComposerValueWithUndo(editor, 'improved prompt')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      'insertText',
      false,
      'improved prompt'
    );
    expect(onInput).toHaveBeenCalled();
  });

  it('falls back when execCommand cannot record an undoable insert', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    stubExecCommand(false);

    expect(replaceComposerValueWithUndo(editor, 'improved prompt')).toBe(false);
  });
});
