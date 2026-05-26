import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import type { Transformer } from '@lexical/markdown';
import type { ExecutorProfileId, SendMessageShortcut } from 'shared/types';

import { TypeaheadOpenProvider } from './context/typeahead-open-context';
import type { WysiwygEditingPluginPolicy } from './editing-plugin-policy';
import type { ClickedElementData } from './nodes/clicked-element-node';
import { ClickedElementInsertPlugin } from './plugins/clicked-element-insert-plugin';
import { CodeBlockShortcutPlugin } from './plugins/code-block-shortcut-plugin';
import { DollarCommandTypeaheadPlugin } from './plugins/dollar-command-typeahead-plugin';
import { FileTagTypeaheadPlugin } from './plugins/file-tag-typeahead-plugin';
import { ImageKeyboardPlugin } from './plugins/image-keyboard-plugin';
import { KeyboardCommandsPlugin } from './plugins/keyboard-commands-plugin';
import { PasteMarkdownPlugin } from './plugins/paste-markdown-plugin';
import { SlashCommandTypeaheadPlugin } from './plugins/slash-command-typeahead-plugin';

type WysiwygEditablePluginsProps = {
  policy: WysiwygEditingPluginPolicy;
  activeTransformers: Transformer[];
  shortcutTransformers: Transformer[];
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
  repoId?: string;
  onCmdEnter?: () => void;
  onShiftCmdEnter?: () => void;
  onChange?: (markdown: string) => void;
  sendShortcut?: SendMessageShortcut;
  onRegisterClickedElementInsert?: (
    insertFn: (data: ClickedElementData) => void
  ) => void;
};

export function WysiwygEditablePlugins({
  policy,
  activeTransformers,
  shortcutTransformers,
  repoIds,
  projectId,
  executorProfile,
  repoId,
  onCmdEnter,
  onShiftCmdEnter,
  onChange,
  sendShortcut,
  onRegisterClickedElementInsert,
}: WysiwygEditablePluginsProps) {
  return (
    <>
      {policy.autoFocus && <AutoFocusPlugin />}
      <HistoryPlugin />
      {policy.markdownHelpers && (
        <>
          <MarkdownShortcutPlugin transformers={shortcutTransformers} />
          <PasteMarkdownPlugin transformers={activeTransformers} />
        </>
      )}
      {policy.typeahead && (
        <TypeaheadOpenProvider>
          <FileTagTypeaheadPlugin trigger="#" projectId={projectId} />
          <FileTagTypeaheadPlugin
            trigger="@"
            repoIds={repoIds}
            projectId={projectId}
          />
          {policy.slashCommandTypeahead && executorProfile && (
            <SlashCommandTypeaheadPlugin
              executorProfile={executorProfile}
              repoId={repoId}
            />
          )}
          {policy.dollarCommandTypeahead && <DollarCommandTypeaheadPlugin />}
          {policy.keyboardCommands && (
            <KeyboardCommandsPlugin
              onCmdEnter={onCmdEnter}
              onShiftCmdEnter={onShiftCmdEnter}
              onChange={onChange}
              transformers={activeTransformers}
              sendShortcut={sendShortcut}
            />
          )}
        </TypeaheadOpenProvider>
      )}
      {policy.imageKeyboard && <ImageKeyboardPlugin />}
      {policy.codeBlockShortcut && <CodeBlockShortcutPlugin />}
      {policy.clickedElementInsert && onRegisterClickedElementInsert && (
        <ClickedElementInsertPlugin
          onRegisterInsert={onRegisterClickedElementInsert}
        />
      )}
    </>
  );
}
