import type { Transformer } from '@lexical/markdown';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ExecutorProfileId } from 'shared/types';

vi.mock('@lexical/react/LexicalAutoFocusPlugin', () => ({
  AutoFocusPlugin: () => <div data-testid="auto-focus-plugin" />,
}));

vi.mock('@lexical/react/LexicalHistoryPlugin', () => ({
  HistoryPlugin: () => <div data-testid="history-plugin" />,
}));

vi.mock('@lexical/react/LexicalMarkdownShortcutPlugin', () => ({
  MarkdownShortcutPlugin: ({
    transformers,
  }: {
    transformers: Transformer[];
  }) => (
    <div data-testid="markdown-shortcut-plugin">{transformers.length}</div>
  ),
}));

vi.mock('./plugins/paste-markdown-plugin', () => ({
  PasteMarkdownPlugin: ({ transformers }: { transformers: Transformer[] }) => (
    <div data-testid="paste-markdown-plugin">{transformers.length}</div>
  ),
}));

vi.mock('./context/typeahead-open-context', () => ({
  TypeaheadOpenProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="typeahead-open-provider">{children}</div>
  ),
}));

vi.mock('./plugins/file-tag-typeahead-plugin', () => ({
  FileTagTypeaheadPlugin: ({
    trigger,
    projectId,
    repoIds,
  }: {
    trigger: string;
    projectId?: string;
    repoIds?: string[];
  }) => (
    <div data-testid={`file-tag-${trigger}`}>
      {projectId ?? repoIds?.join(',') ?? ''}
    </div>
  ),
}));

vi.mock('./plugins/slash-command-typeahead-plugin', () => ({
  SlashCommandTypeaheadPlugin: ({
    repoId,
  }: {
    executorProfile: ExecutorProfileId;
    repoId?: string;
  }) => <div data-testid="slash-command-plugin">{repoId}</div>,
}));

vi.mock('./plugins/dollar-command-typeahead-plugin', () => ({
  DollarCommandTypeaheadPlugin: () => (
    <div data-testid="dollar-command-plugin" />
  ),
}));

vi.mock('./plugins/keyboard-commands-plugin', () => ({
  KeyboardCommandsPlugin: ({
    onCmdEnter,
    onShiftCmdEnter,
    onChange,
    transformers,
    sendShortcut,
  }: {
    onCmdEnter?: () => void;
    onShiftCmdEnter?: () => void;
    onChange?: (markdown: string) => void;
    transformers?: Transformer[];
    sendShortcut?: string;
  }) => (
    <button
      type="button"
      data-transformer-count={transformers?.length}
      data-send-shortcut={sendShortcut}
      onClick={() => {
        onCmdEnter?.();
        onShiftCmdEnter?.();
        onChange?.('updated');
      }}
    >
      keyboard-commands-plugin
    </button>
  ),
}));

vi.mock('./plugins/image-keyboard-plugin', () => ({
  ImageKeyboardPlugin: () => <div data-testid="image-keyboard-plugin" />,
}));

vi.mock('./plugins/code-block-shortcut-plugin', () => ({
  CodeBlockShortcutPlugin: () => (
    <div data-testid="code-block-shortcut-plugin" />
  ),
}));

vi.mock('./plugins/clicked-element-insert-plugin', () => ({
  ClickedElementInsertPlugin: ({
    onRegisterInsert,
  }: {
    onRegisterInsert: (insertFn: () => void) => void;
  }) => (
    <button type="button" onClick={() => onRegisterInsert(() => undefined)}>
      clicked-element-insert-plugin
    </button>
  ),
}));

import { WysiwygEditablePlugins } from './editable-plugins';
import type { WysiwygEditingPluginPolicy } from './editing-plugin-policy';

const fullPolicy: WysiwygEditingPluginPolicy = {
  autoFocus: true,
  markdownHelpers: true,
  typeahead: true,
  slashCommandTypeahead: true,
  dollarCommandTypeahead: true,
  keyboardCommands: true,
  imageKeyboard: true,
  codeBlockShortcut: true,
  clickedElementInsert: true,
};

const offPolicy: WysiwygEditingPluginPolicy = {
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

describe('WysiwygEditablePlugins', () => {
  it('renders the full editable plugin group and passes command props', () => {
    const activeTransformers = [{} as Transformer];
    const shortcutTransformers = [{} as Transformer, {} as Transformer];
    const onCmdEnter = vi.fn();
    const onShiftCmdEnter = vi.fn();
    const onChange = vi.fn();
    const onRegisterClickedElementInsert = vi.fn();

    render(
      <WysiwygEditablePlugins
        policy={fullPolicy}
        activeTransformers={activeTransformers}
        shortcutTransformers={shortcutTransformers}
        projectId="project-1"
        repoIds={['repo-a', 'repo-b']}
        repoId="repo-1"
        executorProfile={
          { executor: 'codex' as const } as ExecutorProfileId
        }
        onCmdEnter={onCmdEnter}
        onShiftCmdEnter={onShiftCmdEnter}
        onChange={onChange}
        sendShortcut="Enter"
        onRegisterClickedElementInsert={onRegisterClickedElementInsert}
      />
    );

    expect(screen.getByTestId('auto-focus-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('history-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-shortcut-plugin')).toHaveTextContent(
      '2'
    );
    expect(screen.getByTestId('paste-markdown-plugin')).toHaveTextContent('1');
    expect(screen.getByTestId('typeahead-open-provider')).toBeInTheDocument();
    expect(screen.getByTestId('file-tag-#')).toHaveTextContent('project-1');
    expect(screen.getByTestId('file-tag-@')).toHaveTextContent('project-1');
    expect(screen.getByTestId('slash-command-plugin')).toHaveTextContent(
      'repo-1'
    );
    expect(screen.getByTestId('dollar-command-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('image-keyboard-plugin')).toBeInTheDocument();
    expect(
      screen.getByTestId('code-block-shortcut-plugin')
    ).toBeInTheDocument();

    const keyboard = screen.getByRole('button', {
      name: 'keyboard-commands-plugin',
    });
    expect(keyboard).toHaveAttribute('data-transformer-count', '1');
    expect(keyboard).toHaveAttribute('data-send-shortcut', 'Enter');
    keyboard.click();
    expect(onCmdEnter).toHaveBeenCalledTimes(1);
    expect(onShiftCmdEnter).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('updated');

    screen
      .getByRole('button', { name: 'clicked-element-insert-plugin' })
      .click();
    expect(onRegisterClickedElementInsert).toHaveBeenCalledTimes(1);
  });

  it('keeps history but suppresses policy-disabled plugins', () => {
    render(
      <WysiwygEditablePlugins
        policy={offPolicy}
        activeTransformers={[]}
        shortcutTransformers={[]}
      />
    );

    expect(screen.getByTestId('history-plugin')).toBeInTheDocument();
    expect(screen.queryByTestId('auto-focus-plugin')).toBeNull();
    expect(screen.queryByTestId('markdown-shortcut-plugin')).toBeNull();
    expect(screen.queryByTestId('typeahead-open-provider')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('image-keyboard-plugin')).toBeNull();
    expect(screen.queryByTestId('code-block-shortcut-plugin')).toBeNull();
  });

  it('requires executor profile and clicked-element callback for those plugins', () => {
    render(
      <WysiwygEditablePlugins
        policy={fullPolicy}
        activeTransformers={[]}
        shortcutTransformers={[]}
        executorProfile={null}
      />
    );

    expect(screen.queryByTestId('slash-command-plugin')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'clicked-element-insert-plugin' })
    ).toBeNull();
  });
});
