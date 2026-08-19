import { describe, expect, it } from 'vitest';
import {
  resolveConversationCollapsePreferences,
  resolveHideModelThinking,
} from './conversationCollapsePreferences';

describe('conversation collapse preferences', () => {
  it('keeps both conversation surfaces collapsed before config loads', () => {
    expect(resolveConversationCollapsePreferences(null)).toEqual({
      collapseAiMessages: true,
      expandFileChanges: false,
    });
  });

  it('honors an explicit opt-out for both preferences', () => {
    expect(
      resolveConversationCollapsePreferences({
        ai_message_default_collapsed: false,
        files_changed_default_collapsed: false,
      })
    ).toEqual({
      collapseAiMessages: false,
      expandFileChanges: true,
    });
  });
});

describe('resolveHideModelThinking', () => {
  it('hides thinking by default before config loads', () => {
    expect(resolveHideModelThinking(null)).toBe(true);
  });

  it('honors an explicit opt-out', () => {
    expect(resolveHideModelThinking({ hide_model_thinking: false })).toBe(
      false
    );
  });
});
