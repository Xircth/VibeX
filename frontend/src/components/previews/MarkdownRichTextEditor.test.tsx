import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'react';
import { MarkdownRichTextEditor } from './MarkdownRichTextEditor';

const richtext = vi.hoisted(() => ({
  markdownToEditorStateJSON: vi.fn((markdown: string) =>
    JSON.stringify({ markdown })
  ),
  editorStateJSONToMarkdown: vi.fn((json: string) => {
    try {
      return (JSON.parse(json) as { markdown?: string }).markdown ?? '';
    } catch {
      return '';
    }
  }),
}));

vi.mock('@astryxdesign/richtext', () => ({
  markdownToEditorStateJSON: richtext.markdownToEditorStateJSON,
  editorStateJSONToMarkdown: richtext.editorStateJSONToMarkdown,
  RichTextEditorToolbar: () => <div data-testid="astryx-rich-text-toolbar" />,
  RichTextEditor: ({
    label,
    defaultValue,
    onChange,
    ref,
  }: {
    label: string;
    defaultValue?: string;
    onChange?: (
      state: unknown,
      editor: { getEditorState: () => unknown }
    ) => void;
    ref?: Ref<{ getMarkdown: () => string }>;
  }) => {
    const markdown =
      defaultValue == null
        ? ''
        : richtext.editorStateJSONToMarkdown(defaultValue);
    if (typeof ref === 'function') {
      ref({ getMarkdown: () => markdown });
    } else if (ref) {
      ref.current = { getMarkdown: () => markdown };
    }
    return (
      <textarea
        aria-label={label}
        defaultValue={markdown}
        onChange={(event) => {
          const next = event.target.value;
          if (typeof ref === 'function') {
            ref({ getMarkdown: () => next });
          } else if (ref) {
            ref.current = { getMarkdown: () => next };
          }
          onChange?.(
            { toJSON: () => ({ markdown: next }) },
            {
              getEditorState: () => ({
                toJSON: () => ({ markdown: next }),
              }),
            }
          );
        }}
      />
    );
  },
}));

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [
    {
      registerCommand: () => () => undefined,
      update: () => undefined,
    },
  ],
}));

describe('MarkdownRichTextEditor', () => {
  beforeEach(() => {
    richtext.markdownToEditorStateJSON.mockClear();
    richtext.editorStateJSONToMarkdown.mockClear();
  });

  it('seeds the editor from markdown and reports edits as markdown', () => {
    const onMarkdownChange = vi.fn();
    const onSave = vi.fn();
    render(
      <MarkdownRichTextEditor
        markdown="# Title"
        label="notes.md"
        workspacePath="/workspace/docs"
        onMarkdownChange={onMarkdownChange}
        onSave={onSave}
      />
    );

    expect(richtext.markdownToEditorStateJSON).toHaveBeenCalledWith('# Title');
    expect(screen.getByTestId('astryx-rich-text-editor')).toHaveAttribute(
      'data-workspace-path',
      '/workspace/docs'
    );
    expect(screen.getByRole('textbox', { name: 'notes.md' })).toHaveValue(
      '# Title'
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'notes.md' }), {
      target: { value: '# Edited' },
    });
    expect(onMarkdownChange).toHaveBeenCalledWith('# Edited');
  });

  it('saves with Ctrl+S', () => {
    const onSave = vi.fn();
    render(
      <MarkdownRichTextEditor
        markdown="# Title"
        label="notes.md"
        workspacePath="/workspace/docs"
        onMarkdownChange={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.keyDown(screen.getByTestId('astryx-rich-text-editor'), {
      key: 's',
      ctrlKey: true,
    });
    expect(onSave).toHaveBeenCalled();
  });
});
