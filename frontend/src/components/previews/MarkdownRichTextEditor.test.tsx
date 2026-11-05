import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode, Ref } from 'react';
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

const lexicalMock = vi.hoisted(() => {
  const updateListeners = new Set<() => void>();
  const rootListeners = new Set<() => void>();
  let rootChildren: unknown[] = [];
  const elementsByKey = new Map<string, HTMLElement>();

  return {
    updateListeners,
    rootListeners,
    elementsByKey,
    getRootChildren: () => rootChildren,
    setRootChildren: (next: unknown[]) => {
      rootChildren = next;
    },
    reset: () => {
      updateListeners.clear();
      rootListeners.clear();
      rootChildren = [];
      elementsByKey.clear();
    },
    editor: {
      registerCommand: () => () => undefined,
      registerUpdateListener: (cb: () => void) => {
        updateListeners.add(cb);
        return () => updateListeners.delete(cb);
      },
      registerRootListener: (cb: () => void) => {
        rootListeners.add(cb);
        return () => rootListeners.delete(cb);
      },
      getEditorState: () => ({
        read: (fn: () => void) => fn(),
        toJSON: () => ({}),
      }),
      getElementByKey: (key: string) => elementsByKey.get(key) ?? null,
      parseEditorState: (json: string) => json,
      setEditorState: () => undefined,
      update: () => undefined,
    },
  };
});

vi.mock('lexical', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lexical')>();
  return {
    ...actual,
    $getRoot: () => ({
      getChildren: () => lexicalMock.getRootChildren(),
    }),
  };
});

vi.mock('@lexical/code', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lexical/code')>();
  return {
    ...actual,
    $isCodeNode: (node: unknown) =>
      Boolean(
        node &&
          typeof node === 'object' &&
          (node as { __type?: string }).__type === 'code'
      ),
  };
});

vi.mock('@/components/NormalizedConversation/MermaidDiagram', () => ({
  MermaidDiagram: ({ value }: { value: string }) => (
    <div data-testid="mermaid-diagram-preview">{value}</div>
  ),
}));

vi.mock('@astryxdesign/richtext', () => ({
  markdownToEditorStateJSON: richtext.markdownToEditorStateJSON,
  editorStateJSONToMarkdown: richtext.editorStateJSONToMarkdown,
  RichTextEditorToolbar: () => <div data-testid="astryx-rich-text-toolbar" />,
  RichTextEditor: ({
    label,
    defaultValue,
    onChange,
    plugins,
    ref,
  }: {
    label: string;
    defaultValue?: string;
    onChange?: (
      state: unknown,
      editor: { getEditorState: () => unknown }
    ) => void;
    plugins?: ReactNode;
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
      <div>
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
        {plugins}
      </div>
    );
  },
}));

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [lexicalMock.editor],
}));

describe('MarkdownRichTextEditor', () => {
  beforeEach(() => {
    richtext.markdownToEditorStateJSON.mockClear();
    richtext.editorStateJSONToMarkdown.mockClear();
    lexicalMock.reset();
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

    expect(richtext.markdownToEditorStateJSON).toHaveBeenCalled();
    expect(screen.getByTestId('astryx-rich-text-editor')).toHaveAttribute(
      'data-workspace-path',
      '/workspace/docs'
    );
    expect(screen.getByTestId('astryx-rich-text-editor')).toHaveClass(
      'markdown-rich-text-editor',
      'conv-markdown',
      'markdown-file-prose'
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

  it('renders a live Mermaid diagram preview beneath mermaid code blocks and updates on edits', () => {
    const hostContainer = document.createElement('div');
    const codeBlockEl = document.createElement('code');
    hostContainer.appendChild(codeBlockEl);
    document.body.appendChild(hostContainer);

    lexicalMock.elementsByKey.set('code-1', codeBlockEl);
    lexicalMock.setRootChildren([
      {
        __type: 'code',
        getKey: () => 'code-1',
        getLanguage: () => 'mermaid',
        getTextContent: () => 'graph TD;\nA-->B;',
      },
    ]);

    const { unmount } = render(
      <MarkdownRichTextEditor
        markdown={'```mermaid\ngraph TD;\nA-->B;\n```'}
        label="diagram.md"
        workspacePath="/workspace/docs"
        onMarkdownChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const preview = screen.getByTestId('mermaid-diagram-preview');
    expect(preview).toHaveTextContent('graph TD; A-->B;');
    expect(codeBlockEl.nextElementSibling).toHaveClass(
      'markdown-rich-text-mermaid-preview'
    );
    expect(codeBlockEl.nextElementSibling).toHaveAttribute(
      'contenteditable',
      'false'
    );

    act(() => {
      lexicalMock.setRootChildren([
        {
          __type: 'code',
          getKey: () => 'code-1',
          getLanguage: () => 'mermaid',
          getTextContent: () => 'sequenceDiagram\nAlice->>Bob: Hi',
        },
      ]);
      for (const listener of lexicalMock.updateListeners) {
        listener();
      }
    });

    expect(screen.getByTestId('mermaid-diagram-preview')).toHaveTextContent(
      'sequenceDiagram Alice->>Bob: Hi'
    );

    unmount();
    hostContainer.remove();
  });
});
