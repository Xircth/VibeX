import { describe, expect, it } from 'vitest';
import { AgentKind, type ExecutorProfileId } from 'shared/types';

import { getWysiwygEditingPluginPolicy } from './editing-plugin-policy';

function profile(executor: AgentKind): ExecutorProfileId {
  return { executor, variant: null };
}

describe('WYSIWYG editing plugin policy', () => {
  it('enables no editing plugins in disabled mode', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: true,
        markdownPreset: 'default',
        autoFocus: true,
        executorProfile: profile('codex' as const),
        hasClickedElementInsert: true,
      })
    ).toEqual({
      autoFocus: false,
      markdownHelpers: false,
      typeahead: false,
      slashCommandTypeahead: false,
      dollarCommandTypeahead: false,
      keyboardCommands: false,
      imageKeyboard: false,
      codeBlockShortcut: false,
      clickedElementInsert: false,
    });
  });

  it('enables rich markdown editing helpers for the default editable preset', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: false,
        executorProfile: null,
        hasClickedElementInsert: false,
      })
    ).toMatchObject({
      markdownHelpers: true,
      typeahead: true,
      keyboardCommands: true,
      imageKeyboard: true,
      codeBlockShortcut: true,
    });
  });

  it('keeps typeahead and keyboard plugins but disables rich markdown helpers for minimal input', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'session-input-minimal',
        autoFocus: false,
        executorProfile: null,
        hasClickedElementInsert: false,
      })
    ).toMatchObject({
      markdownHelpers: false,
      typeahead: true,
      keyboardCommands: true,
      imageKeyboard: true,
      codeBlockShortcut: false,
    });
  });

  it('enables slash command typeahead only when an executor profile is present', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: false,
        executorProfile: null,
        hasClickedElementInsert: false,
      }).slashCommandTypeahead
    ).toBe(false);
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: false,
        executorProfile: profile('claude_code' as const),
        hasClickedElementInsert: false,
      }).slashCommandTypeahead
    ).toBe(true);
  });

  it('enables dollar command typeahead only for Codex executor profiles', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: false,
        executorProfile: profile('claude_code' as const),
        hasClickedElementInsert: false,
      }).dollarCommandTypeahead
    ).toBe(false);
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: false,
        executorProfile: profile('codex' as const),
        hasClickedElementInsert: false,
      }).dollarCommandTypeahead
    ).toBe(true);
  });

  it('keeps autofocus and clicked-element insert gated by their inputs in editable mode', () => {
    expect(
      getWysiwygEditingPluginPolicy({
        disabled: false,
        markdownPreset: 'default',
        autoFocus: true,
        executorProfile: null,
        hasClickedElementInsert: true,
      })
    ).toMatchObject({
      autoFocus: true,
      clickedElementInsert: true,
    });
  });
});
