import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerInput } from './SessionComposerInput';
import {
  clearCurrentDraggedFileReference,
  setCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';
import {
  formatSessionComposerCommand,
  insertPreviewElementToken,
} from './sessionComposerStructuredTokens';

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
  return screen.getByRole('textbox') as HTMLDivElement;
}

function typePlainText(editor: HTMLDivElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

function setCaretInTextNode(textNode: ChildNode, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertCharAtCurrentSelection(editor: HTMLDivElement, char: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error('expected selection');
  }

  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  const offset = range.startOffset;

  if (container.nodeType !== Node.TEXT_NODE) {
    throw new Error('expected text node selection');
  }

  const textNode = container as Text;
  const currentText = textNode.textContent ?? '';
  textNode.textContent =
    currentText.slice(0, offset) + char + currentText.slice(offset);
  setCaretInTextNode(textNode, offset + char.length);
  fireEvent.input(editor);
}

describe('SessionComposerInput', () => {
  it('reports contenteditable text changes as Text content', () => {
    const onChange = vi.fn();
    renderComposerInput({ onChange });

    typePlainText(getEditor(), 'ship this');

    expect(onChange).toHaveBeenCalledWith('ship this');
  });

  it('keeps typing order stable across controlled rerenders', async () => {
    function StatefulComposer() {
      const [value, setValue] = useState('');

      return (
        <SessionComposerInput
          value={value}
          images={[]}
          onChange={setValue}
          onSubmit={() => {}}
          onAttachImages={() => {}}
          onRemoveImage={() => {}}
        />
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatefulComposer />
      </QueryClientProvider>
    );

    const editor = getEditor();
    editor.focus();
    editor.textContent = 'd';
    const firstTextNode = editor.firstChild;
    if (!firstTextNode) {
      throw new Error('expected first text node');
    }
    setCaretInTextNode(firstTextNode, 1);
    await act(async () => {
      fireEvent.input(editor);
      await Promise.resolve();
    });

    await act(async () => {
      insertCharAtCurrentSelection(editor, 'a');
      insertCharAtCurrentSelection(editor, 'd');
      insertCharAtCurrentSelection(editor, 'a');
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('dada');
  });

  it('submits on Enter when Enter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({ context: { sendShortcut: 'Enter' }, onSubmit });

    fireEvent.keyDown(getEditor(), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Ctrl+Enter when ModifierEnter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({
      context: { sendShortcut: 'ModifierEnter' },
      onSubmit,
    });

    fireEvent.keyDown(getEditor(), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on plain Enter when ModifierEnter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({
      context: { sendShortcut: 'ModifierEnter' },
      onSubmit,
    });

    fireEvent.keyDown(getEditor(), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('inserts plain newlines when Enter is not the submit shortcut', () => {
    const onChange = vi.fn();
    renderComposerInput({
      value: 'line1',
      context: { sendShortcut: 'Enter' },
      onChange,
    });

    const editor = getEditor();
    const textNode = editor.firstChild;
    if (!textNode) {
      throw new Error('expected text node');
    }
    setCaretInTextNode(textNode, 'line1'.length);

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    expect(onChange).toHaveBeenCalledWith('line1\n');
  });

  it('keeps newline insertion stable when text follows a command chip', () => {
    const onChange = vi.fn();
    const command = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    renderComposerInput({
      value: `Review ${command} next`,
      context: { sendShortcut: 'Enter' },
      onChange,
    });

    const editor = getEditor();
    const trailingText = editor.childNodes[2];
    setCaretInTextNode(trailingText, 1);

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    expect(onChange).toHaveBeenCalledWith(`Review ${command} \nnext`);
  });

  it('inserts a newline on the first Shift+Enter across controlled rerenders', async () => {
    function StatefulComposer() {
      const [value, setValue] = useState('line1');

      return (
        <SessionComposerInput
          value={value}
          images={[]}
          context={{ sendShortcut: 'Enter' }}
          onChange={setValue}
          onSubmit={() => {}}
          onAttachImages={() => {}}
          onRemoveImage={() => {}}
        />
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatefulComposer />
      </QueryClientProvider>
    );

    const editor = getEditor();
    const textNode = editor.firstChild;
    if (!textNode) {
      throw new Error('expected text node');
    }

    editor.focus();
    setCaretInTextNode(textNode, 'line1'.length);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('line1\n');
  });

  it('uses the latest editor text when Shift+Enter lands before the controlled value rerender finishes', async () => {
    function StatefulComposer() {
      const [value, setValue] = useState('');

      return (
        <SessionComposerInput
          value={value}
          images={[]}
          context={{ sendShortcut: 'Enter' }}
          onChange={setValue}
          onSubmit={() => {}}
          onAttachImages={() => {}}
          onRemoveImage={() => {}}
        />
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatefulComposer />
      </QueryClientProvider>
    );

    const editor = getEditor();
    editor.focus();
    editor.textContent = 'a';
    const firstTextNode = editor.firstChild;
    if (!firstTextNode) {
      throw new Error('expected first text node');
    }
    setCaretInTextNode(firstTextNode, 1);

    await act(async () => {
      fireEvent.input(editor);
      fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('a\n');
  });

  it('keeps the caret visible after Shift+Enter adds lines below the fold', async () => {
    function StatefulComposer() {
      const [value, setValue] = useState('line1\nline2\nline3\nline4');

      return (
        <SessionComposerInput
          value={value}
          images={[]}
          context={{ sendShortcut: 'Enter' }}
          onChange={setValue}
          onSubmit={() => {}}
          onAttachImages={() => {}}
          onRemoveImage={() => {}}
        />
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <StatefulComposer />
      </QueryClientProvider>
    );

    const editor = getEditor();
    const textNode = editor.firstChild;
    if (!textNode) {
      throw new Error('expected text node');
    }

    editor.focus();
    Object.defineProperty(editor, 'clientHeight', {
      configurable: true,
      value: 40,
    });
    Object.defineProperty(editor, 'scrollTop', {
      configurable: true,
      value: 0,
      writable: true,
    });
    const editorRectSpy = vi.spyOn(editor, 'getBoundingClientRect');
    editorRectSpy.mockReturnValue({
      top: 0,
      bottom: 40,
      left: 0,
      right: 320,
      width: 320,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function mockCollapsedCaretRect(this: Range) {
        const prefix =
          this.startContainer.nodeType === Node.TEXT_NODE
            ? (this.startContainer.textContent ?? '').slice(0, this.startOffset)
            : (editor.textContent ?? '').slice(0, this.startOffset);
        const lineIndex = prefix.split('\n').length - 1;
        const top = lineIndex * 20;

        return {
          top,
          bottom: top + 20,
          left: 0,
          right: 1,
          width: 1,
          height: 20,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    });

    setCaretInTextNode(textNode, (textNode.textContent ?? '').length);

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
      await Promise.resolve();
    });

    expect(editor.textContent).toBe('line1\nline2\nline3\nline4\n');
    expect(editor.scrollTop).toBeGreaterThan(0);

    editorRectSpy.mockRestore();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalRangeRect,
    });
  });

  it('renders Command content as non-editable inline chips without a hidden textarea mirror', () => {
    const fileCommand = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    const dollarCommand = formatSessionComposerCommand({
      type: '$',
      key: 'plan',
      value: '$plan',
    });

    renderComposerInput({
      value: `Run ${dollarCommand} on ${fileCommand}`,
    });

    const inputSurface = screen.getByTestId('session-composer-input-surface');
    const editor = getEditor();

    expect(inputSurface).toContainElement(editor);
    expect(screen.queryByRole('textbox', { hidden: true })).not.toHaveClass(
      'text-transparent'
    );
    expect(screen.queryByTestId('session-composer-input-mirror')).toBeNull();
    expect(editor).toHaveTextContent('Run');
    expect(within(editor).getByText('$plan')).toBeInTheDocument();
    expect(within(editor).getByText('App.tsx')).toBeInTheDocument();

    const fileChip = within(editor)
      .getByText('App.tsx')
      .closest('[data-testid="session-composer-token-chip"]');
    expect(fileChip).toHaveAttribute('contenteditable', 'false');
    expect(fileChip).toHaveAttribute('data-command-raw', fileCommand);
    expect(fileChip).toHaveAttribute('title', 'src/App.tsx');
  });

  it('exposes preview element context on the whole element command chip', () => {
    const elementContext =
      'From preview click:\n- DOM: button.primary\n- Selected start: SaveButton (`src/App.tsx:12:3`)';
    const value = insertPreviewElementToken({
      value: 'Fix',
      selectionStart: 3,
      selectionEnd: 3,
      componentName: 'SaveButton',
      filePath: 'src/App.tsx:12:3',
      fullMarkdown: elementContext,
    }).value;

    renderComposerInput({ value });

    const chip = screen
      .getByText('SaveButton')
      .closest('[data-testid="session-composer-token-chip"]');

    expect(chip).toHaveAttribute('title', elementContext);
    expect(chip).toHaveAttribute('contenteditable', 'false');
    expect(chip).toHaveClass('cursor-default');
    expect(chip).toHaveClass('select-none');
  });

  it('does not open typeahead when the caret is adjacent to a command chip', () => {
    const command = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    renderComposerInput({ value: `Review ${command} ` });

    const editor = getEditor();
    const trailingSpace = editor.childNodes[2];
    setCaretInTextNode(trailingSpace, 0);
    fireEvent.keyUp(editor, { key: 'ArrowRight' });

    expect(screen.queryByText('No matching files found.')).toBeNull();
    expect(screen.queryByText('Searching files...')).toBeNull();
  });

  it('deletes a whole command chip with Backspace instead of editing command text', () => {
    const onChange = vi.fn();
    const command = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    renderComposerInput({ value: `Review ${command} now`, onChange });

    const editor = getEditor();
    const trailingText = editor.childNodes[2];
    setCaretInTextNode(trailingText, 0);

    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(onChange).toHaveBeenCalledWith('Review now');
  });

  it('accepts file-tree custom drops and inserts an @ command object', () => {
    const onChange = vi.fn();
    renderComposerInput({ value: 'Review ', onChange });

    const dropZone = screen.getByTestId('session-composer-file-drop-zone');
    dropZone.dispatchEvent(
      new CustomEvent('vibe-file-reference-drop', {
        detail: {
          fileName: 'README.md',
          relativePath: 'docs/README.md',
          kind: 'file',
        },
      })
    );

    expect(onChange).toHaveBeenCalledWith(
      `Review ${formatSessionComposerCommand({
        type: '@',
        key: 'README.md',
        value: 'docs/README.md',
      })} `
    );
  });

  it('accepts active file-tree drag state on editor drop', () => {
    const onChange = vi.fn();
    renderComposerInput({ value: '', onChange });
    setCurrentDraggedFileReference({
      fileName: 'src',
      relativePath: 'src',
      kind: 'directory',
    });

    fireEvent.drop(getEditor(), {
      dataTransfer: {
        files: [],
        types: [],
        getData: () => '',
      },
    });

    expect(onChange).toHaveBeenCalledWith(
      `${formatSessionComposerCommand({
        type: '@',
        key: 'src',
        value: 'src',
      })} `
    );
    clearCurrentDraggedFileReference();
  });
});
