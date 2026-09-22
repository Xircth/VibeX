import { afterEach, describe, expect, it, vi } from 'vitest';

import { replaceComposerValueWithUndo } from './replaceComposerValueWithUndo';

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: execCommand,
  });
  return execCommand;
}

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
