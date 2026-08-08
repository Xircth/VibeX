import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerInput } from './SessionComposerInput';
import type { FileReferencePayload } from '@/utils/fileReferences';
import { setCurrentDraggedFileReference } from '@/utils/fileReferenceDrag';

function renderComposerInput(
  props: Partial<Parameters<typeof SessionComposerInput>[0]> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionComposerInput
        value=""
        images={[]}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAttachImages={vi.fn()}
        onRemoveImage={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

function getEditor(): HTMLDivElement {
  const surface = screen.getByTestId('session-composer-editor');
  return surface.querySelector(
    '[contenteditable="true"]'
  ) as HTMLDivElement;
}

describe('SessionComposerInput (Astryx)', () => {
  it('reports contenteditable text changes as Text content', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');

    expect(onChange).toHaveBeenLastCalledWith('hello');
  });

  it('submits on Enter when Enter is the send shortcut', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'run tests');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on the Enter that commits an IME composition', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '你好');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits on Ctrl+Enter when ModifierEnter is the send shortcut', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({
      onSubmit,
      context: { sendShortcut: 'ModifierEnter' },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'run tests');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on plain Enter when ModifierEnter is the send shortcut', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({
      onSubmit,
      context: { sendShortcut: 'ModifierEnter' },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'run tests');
    await user.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('inserts a newline when Enter is not the submit shortcut', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({
      onChange,
      context: { sendShortcut: 'ModifierEnter' },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'line1');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenLastCalledWith('line1\n');
  });

  it('opens the dollar trigger menu and inserts a structured token on select', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');

    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const [inserted] = onChange.mock.calls.at(-1) as [string];
    expect(inserted).toMatch(/^Use \[\$:[^\]]+\]\([^)]*\)/);
  });

  it('deletes a whole structured token with Backspace', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');

    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    // jsdom does not keep the caret Astryx placed after the token's trailing
    // NBSP; restore it so the built-in Backspace handling runs.
    const tokenSpan = editor.querySelector('[data-astryx-token]');
    const nbsp = tokenSpan?.nextSibling;
    if (nbsp) {
      const range = document.createRange();
      range.setStart(nbsp, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    // Caret lands after the inserted token; Backspace removes it atomically.
    await user.keyboard('{Backspace}');

    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('Use ');
  });

  it('accepts file-tree custom drops and inserts an @ command token', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const payload: FileReferencePayload = {
      relativePath: 'src/lib/utils.ts',
      fileName: 'utils.ts',
      kind: 'file',
    };
    setCurrentDraggedFileReference(payload);
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    const dataTransfer = {
      types: [] as string[],
      files: [] as File[],
      getData: () => '',
    };
    // fireEvent.drop with the custom drag state read from the module store.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(editor, { dataTransfer });

    await waitFor(() => {
      const [dropped] = onChange.mock.calls.at(-1) as [string];
      // Astryx keeps a trailing NBSP after inserted tokens so the caret can
      // keep typing; it serializes into the value string.
      expect(dropped.replace(/\u00A0$/, '')).toBe(
        '[@:utils.ts](src/lib/utils.ts)'
      );
    });
  });
});
