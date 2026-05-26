import type { Transformer } from '@lexical/markdown';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DragEvent, DragEventHandler, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorState, LexicalEditor } from 'lexical';

const dragCaptureStopPropagation = vi.hoisted(() => vi.fn());

vi.mock('@lexical/react/LexicalComposer', () => ({
  LexicalComposer: ({
    initialConfig,
    children,
  }: {
    initialConfig: { namespace: string };
    children: ReactNode;
  }) => (
    <div data-testid="lexical-composer" data-namespace={initialConfig.namespace}>
      {children}
    </div>
  ),
}));

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [{ id: 'editor' }],
}));

vi.mock('@lexical/react/LexicalRichTextPlugin', () => ({
  RichTextPlugin: ({
    contentEditable,
    placeholder,
  }: {
    contentEditable: ReactNode;
    placeholder: ReactNode;
    ErrorBoundary: unknown;
  }) => (
    <div data-testid="rich-text-plugin">
      {contentEditable}
      {placeholder}
    </div>
  ),
}));

vi.mock('@lexical/react/LexicalContentEditable', () => ({
  ContentEditable: ({
    'aria-label': ariaLabel,
    className,
    onDragStartCapture,
    onDragEnterCapture,
    onDragOverCapture,
    onDragLeaveCapture,
    onDropCapture,
    onDragOver,
    onDrop,
  }: {
    'aria-label': string;
    className?: string;
    onDragStartCapture?: DragEventHandler<HTMLDivElement>;
    onDragEnterCapture?: DragEventHandler<HTMLDivElement>;
    onDragOverCapture?: DragEventHandler<HTMLDivElement>;
    onDragLeaveCapture?: DragEventHandler<HTMLDivElement>;
    onDropCapture?: DragEventHandler<HTMLDivElement>;
    onDragOver?: DragEventHandler<HTMLDivElement>;
    onDrop?: DragEventHandler<HTMLDivElement>;
  }) => {
    const createDragEvent = () =>
      ({
        stopPropagation: dragCaptureStopPropagation,
      }) as unknown as DragEvent<HTMLDivElement>;

    return (
      <div
        role="textbox"
        aria-label={ariaLabel}
        data-testid="content-editable"
        className={className}
        onDragStartCapture={onDragStartCapture}
        onDragEnterCapture={onDragEnterCapture}
        onDragOverCapture={onDragOverCapture}
        onDragLeaveCapture={onDragLeaveCapture}
        onDropCapture={onDropCapture}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <button
          type="button"
          data-testid="trigger-drag-captures"
          onClick={() => {
            onDragStartCapture?.(createDragEvent());
            onDragEnterCapture?.(createDragEvent());
            onDragOverCapture?.(createDragEvent());
            onDragLeaveCapture?.(createDragEvent());
            onDropCapture?.(createDragEvent());
          }}
        />
        <button
          type="button"
          data-testid="trigger-runtime-drag"
          onClick={() => {
            onDragOver?.(createDragEvent());
            onDrop?.(createDragEvent());
          }}
        />
      </div>
    );
  },
}));

vi.mock('@lexical/react/LexicalErrorBoundary', () => ({
  LexicalErrorBoundary: () => null,
}));

vi.mock('@lexical/react/LexicalListPlugin', () => ({
  ListPlugin: () => <div data-testid="list-plugin" />,
}));

vi.mock('@lexical/react/LexicalTablePlugin', () => ({
  TablePlugin: () => <div data-testid="table-plugin" />,
}));

vi.mock('./plugins/code-highlight-plugin', () => ({
  CodeHighlightPlugin: () => <div data-testid="code-highlight-plugin" />,
}));

vi.mock('./plugins/toolbar-plugin', () => ({
  ToolbarPlugin: () => <div data-testid="toolbar-plugin" />,
}));

vi.mock('./plugins/static-toolbar-plugin', () => ({
  StaticToolbarPlugin: ({ saveStatus }: { saveStatus?: string }) => (
    <div data-testid="static-toolbar-plugin">{saveStatus}</div>
  ),
}));

vi.mock('./plugins/markdown-sync-plugin', () => ({
  MarkdownSyncPlugin: ({
    value,
    editable,
    transformers,
  }: {
    value: string;
    onChange?: (markdown: string) => void;
    onEditorStateChange?: (state: EditorState) => void;
    editable: boolean;
    transformers: Transformer[];
  }) => (
    <div
      data-testid="markdown-sync-plugin"
      data-value={value}
      data-editable={String(editable)}
      data-transformers={transformers.length}
    />
  ),
}));

vi.mock('./editable-plugins', () => ({
  WysiwygEditablePlugins: () => <div data-testid="editable-plugins" />,
}));

vi.mock('./read-only-plugins', () => ({
  WysiwygReadOnlyPlugins: () => <div data-testid="read-only-plugins" />,
}));

vi.mock('./editor-context-providers', () => ({
  WysiwygEditorContextProviders: ({
    taskAttemptId,
    taskId,
    localImages,
    children,
  }: {
    taskAttemptId?: string;
    taskId?: string;
    localImages?: unknown[];
    children: ReactNode;
  }) => (
    <div
      data-testid="editor-context-providers"
      data-task-attempt-id={taskAttemptId}
      data-task-id={taskId}
      data-local-images={localImages?.length ?? 0}
    >
      {children}
    </div>
  ),
}));

import { WysiwygEditorShell } from './editor-shell';
import type { WysiwygEditingPluginPolicy } from './editing-plugin-policy';

const policy: WysiwygEditingPluginPolicy = {
  autoFocus: false,
  markdownHelpers: false,
  typeahead: false,
  slashCommandTypeahead: false,
  dollarCommandTypeahead: false,
  keyboardCommands: false,
  imageKeyboard: false,
  codeBlockShortcut: false,
  clickedElementInsert: false,
};

function renderShell(
  overrides: Partial<React.ComponentProps<typeof WysiwygEditorShell>> = {}
) {
  const editorRef = { current: null as LexicalEditor | null };
  const dropZoneRef = { current: null as HTMLDivElement | null };
  const handleDragOver = vi.fn();
  const handleDrop = vi.fn();

  render(
    <WysiwygEditorShell
      fileReferenceDropZoneRef={dropZoneRef}
      editorInstanceRef={editorRef}
      isSessionInputMinimalPreset={false}
      initialConfig={{ namespace: 'md-wysiwyg', onError: vi.fn() }}
      value="hello"
      editable
      activeTransformers={[{} as Transformer]}
      shortcutTransformers={[]}
      placeholderElement={<span>placeholder</span>}
      className="editor-class"
      handleDragOver={handleDragOver}
      handleDrop={handleDrop}
      enableFloatingToolbar
      showStaticToolbar={false}
      editingPluginPolicy={policy}
      {...overrides}
    />
  );

  return {
    dropZoneRef,
    editorRef,
    handleDragOver,
    handleDrop,
  };
}

describe('WysiwygEditorShell', () => {
  it('wires the editable shell, context providers, composer, markdown sync, and core plugins', () => {
    const { dropZoneRef, editorRef } = renderShell({
      taskAttemptId: 'attempt-1',
      taskId: 'task-1',
      localImages: [
        {
          path: '.vibe-images/image.png',
          proxy_url: '/image',
          file_name: 'image.png',
          size_bytes: 1,
          format: 'png',
        },
      ],
      saveStatus: 'saved',
      showStaticToolbar: true,
    });

    expect(screen.getByTestId('editor-context-providers')).toHaveAttribute(
      'data-task-attempt-id',
      'attempt-1'
    );
    expect(screen.getByTestId('editor-context-providers')).toHaveAttribute(
      'data-task-id',
      'task-1'
    );
    expect(screen.getByTestId('editor-context-providers')).toHaveAttribute(
      'data-local-images',
      '1'
    );
    expect(screen.getByTestId('lexical-composer')).toHaveAttribute(
      'data-namespace',
      'md-wysiwyg'
    );
    expect(screen.getByTestId('markdown-sync-plugin')).toHaveAttribute(
      'data-value',
      'hello'
    );
    expect(screen.getByTestId('markdown-sync-plugin')).toHaveAttribute(
      'data-editable',
      'true'
    );
    expect(screen.getByTestId('markdown-sync-plugin')).toHaveAttribute(
      'data-transformers',
      '1'
    );
    expect(screen.getByTestId('toolbar-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('static-toolbar-plugin')).toHaveTextContent(
      'saved'
    );
    expect(screen.getByTestId('list-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('table-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('code-highlight-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('editable-plugins')).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-plugins')).toBeNull();
    expect(screen.getByText('placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('content-editable')).toHaveAttribute(
      'aria-label',
      'Markdown editor'
    );
    expect(screen.getByTestId('content-editable')).toHaveClass('editor-class');
    expect(dropZoneRef.current).toBe(screen.getByTestId('wysiwyg-drop-zone'));
    expect(editorRef.current).toEqual({ id: 'editor' });
  });

  it('switches to read-only mode and minimal shell styling', () => {
    renderShell({
      editable: false,
      enableFloatingToolbar: true,
      showStaticToolbar: true,
      isSessionInputMinimalPreset: true,
    });

    expect(screen.queryByTestId('toolbar-plugin')).toBeNull();
    expect(screen.queryByTestId('static-toolbar-plugin')).toBeNull();
    expect(screen.queryByTestId('editable-plugins')).toBeNull();
    expect(screen.getByTestId('read-only-plugins')).toBeInTheDocument();
    expect(screen.getByTestId('content-editable')).toHaveAttribute(
      'aria-label',
      'Markdown content'
    );
    expect(screen.getByTestId('wysiwyg-drop-zone')).toHaveClass(
      'text-[13px]'
    );
  });

  it('keeps content editable drag capture stops and runtime handlers', () => {
    const { handleDragOver, handleDrop } = renderShell();
    dragCaptureStopPropagation.mockClear();

    fireEvent.click(screen.getByTestId('trigger-drag-captures'));
    expect(dragCaptureStopPropagation).toHaveBeenCalledTimes(5);

    fireEvent.click(screen.getByTestId('trigger-runtime-drag'));

    expect(handleDragOver).toHaveBeenCalled();
    expect(handleDrop).toHaveBeenCalled();
  });
});
