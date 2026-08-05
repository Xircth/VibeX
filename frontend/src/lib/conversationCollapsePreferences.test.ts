import { describe, expect, it } from 'vitest';
import { resolveConversationCollapsePreferences } from './conversationCollapsePreferences';

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
