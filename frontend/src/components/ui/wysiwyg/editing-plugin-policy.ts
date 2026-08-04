import { type ExecutorProfileId } from 'shared/types';
import type { WysiwygMarkdownPreset } from '../wysiwyg';

export type WysiwygEditingPluginPolicy = {
  autoFocus: boolean;
  markdownHelpers: boolean;
  typeahead: boolean;
  slashCommandTypeahead: boolean;
  dollarCommandTypeahead: boolean;
  keyboardCommands: boolean;
  imageKeyboard: boolean;
  codeBlockShortcut: boolean;
  clickedElementInsert: boolean;
};

export function getWysiwygEditingPluginPolicy({
  disabled,
  markdownPreset,
  autoFocus,
  executorProfile,
  hasClickedElementInsert,
}: {
  disabled: boolean;
  markdownPreset: WysiwygMarkdownPreset;
  autoFocus: boolean;
  executorProfile: ExecutorProfileId | null;
  hasClickedElementInsert: boolean;
}): WysiwygEditingPluginPolicy {
  if (disabled) {
    return {
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
  }

  const isSessionInputMinimal = markdownPreset === 'session-input-minimal';

  return {
    autoFocus,
    markdownHelpers: !isSessionInputMinimal,
    typeahead: true,
    slashCommandTypeahead: Boolean(executorProfile),
    dollarCommandTypeahead: executorProfile?.executor === 'codex',
    keyboardCommands: true,
    imageKeyboard: true,
    codeBlockShortcut: !isSessionInputMinimal,
    clickedElementInsert: hasClickedElementInsert,
  };
}
