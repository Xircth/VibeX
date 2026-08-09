import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerInput } from './SessionComposerInput';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
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
  return surface.querySelector('[contenteditable="true"]') as HTMLDivElement;
}

describe('SessionComposerInput (Astryx)', () => {
  it('constrains the trigger menu to the composer width', async () => {
    const user = userEvent.setup();
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        bottom: 180,
        height: 40,
        left: 24,
        right: 444,
        top: 140,
        width: 420,
        x: 24,
        y: 140,
        toJSON: () => ({}),
      });

    renderComposerInput();
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '/');

    const menu = await screen.findByRole('listbox');
    expect(menu.closest('[popover]')).toHaveStyle({ width: '420px' });

    rectSpy.mockRestore();
  });

  it('renders compact, semantically identified trigger rows', async () => {
    const user = userEvent.setup();
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$');

    const option = (await screen.findAllByRole('option'))[0];
    const row = option.querySelector('[data-composer-trigger-kind="dollar"]');
    expect(row).toBeInTheDocument();
    expect(row?.querySelector('[data-composer-trigger-label]')).toHaveClass(
      'composer-trigger-label'
    );
    expect(
      row?.querySelector('[data-composer-trigger-description]')
    ).toHaveClass('composer-trigger-description');
  });

  it('restores serialized structured tokens as token chips', async () => {
    renderComposerInput({
      value: 'Review [@:App.tsx](src/App.tsx) before sending',
    });

    const editor = getEditor();
    await waitFor(() => {
      const token = editor.querySelector('[data-astryx-token]');
      expect(token).toHaveAttribute(
        'data-astryx-token-value',
        '[@:App.tsx](src/App.tsx)'
      );
      expect(token).toHaveTextContent('App.tsx');
    });
  });

  it('shows Web Preview element details when its token is hovered', async () => {
    const elementContext = [
      'From preview click:',
      '- DOM: button#save.primary@button',
      '- Selector: `button#save`',
      '- Selected start: SaveButton (`src/App.tsx:12:3`)',
      '- Element source:',
      '```html',
      '<button id="save" class="primary">Save</button>',
      '```',
    ].join('\n');
    const elementToken = formatSessionComposerCommand({
      type: '@',
      key: 'SaveButton',
      value: elementContext,
    });
    renderComposerInput({ value: `Fix ${elementToken}` });

    const editor = getEditor();
    const token = await waitFor(() => {
      const restoredToken = editor.querySelector<HTMLElement>(
        '[data-token-kind="element"]'
      );
      expect(restoredToken).not.toBeNull();
      return restoredToken!;
    });

    fireEvent.pointerOver(token);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('SaveButton');
    expect(tooltip).toHaveTextContent('button#save.primary@button');
    expect(tooltip).toHaveTextContent('src/App.tsx:12:3');
    expect(tooltip).toHaveTextContent('button#save');
    expect(tooltip).toHaveTextContent(
      '<button id="save" class="primary">Save</button>'
    );

    fireEvent.pointerOut(token);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    await act(async () => {
      token.focus();
    });
    expect(token).toHaveFocus();
    expect(token).toHaveAttribute('tabindex', '0');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('SaveButton');
  });

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

  it('deletes a token in one Backspace when the caret is at the following text node boundary', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const tokenSpan = editor.querySelector('[data-astryx-token]');
    const followingText = tokenSpan?.nextSibling;
    expect(followingText?.nodeType).toBe(Node.TEXT_NODE);
    if (!followingText) throw new Error('Expected text after token');

    const range = document.createRange();
    range.setStart(followingText, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await user.keyboard('{Backspace}');

    expect(editor.querySelector('[data-astryx-token]')).not.toBeInTheDocument();
    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('Use ');
  });

  it('deletes a token in one Backspace when the caret is after its spacer node', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const tokenSpan = editor.querySelector('[data-astryx-token]');
    expect(tokenSpan?.nextSibling?.textContent).toBe('\u00A0');

    // WebKit can represent the caret after an atomic contenteditable token as
    // a parent boundary after Astryx's trailing NBSP instead of inside it.
    const range = document.createRange();
    range.setStart(editor, editor.childNodes.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await user.keyboard('{Backspace}');

    expect(editor.querySelector('[data-astryx-token]')).not.toBeInTheDocument();
    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('');
  });

  it('uses distinct token tones instead of rendering every token neutral', async () => {
    const user = userEvent.setup();
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    expect(editor.querySelector('.astryx-badge')).toHaveAttribute(
      'data-variant',
      'green'
    );
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
