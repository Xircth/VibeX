import { describe, expect, it } from 'vitest';
import { getComposerHotkeyScopeActivation } from './sessionComposerHotkeys';

describe('session composer hotkey helpers', () => {
  it('activates composer scopes only while the editable textarea is focused', () => {
    expect(
      getComposerHotkeyScopeActivation({
        isEditable: true,
        isTextareaFocused: true,
      })
    ).toEqual({
      isFollowUpScopeActive: true,
      isFollowUpReadyScopeActive: true,
    });
  });

  it('suppresses both scopes when the composer is readonly', () => {
    expect(
      getComposerHotkeyScopeActivation({
        isEditable: false,
        isTextareaFocused: true,
      })
    ).toEqual({
      isFollowUpScopeActive: false,
      isFollowUpReadyScopeActive: false,
    });
  });

  it('suppresses both scopes when the textarea is not focused', () => {
    expect(
      getComposerHotkeyScopeActivation({
        isEditable: true,
        isTextareaFocused: false,
      })
    ).toEqual({
      isFollowUpScopeActive: false,
      isFollowUpReadyScopeActive: false,
    });
  });
});
