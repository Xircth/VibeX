import { describe, expect, it } from 'vitest';
import { stripPreviouslyDisplayedAssistantPrefix } from './useConversationHistory';

describe('useConversationHistory helpers', () => {
  it('strips assistant transcript replay prefixes from later ACP turns', () => {
    const firstReply =
      'I checked the frontend startup path and found the dev server.';
    const secondReply =
      'I will now restart the backend and verify the frontend URL.';

    expect(
      stripPreviouslyDisplayedAssistantPrefix(
        `${firstReply}\n\n${secondReply}`,
        firstReply
      )
    ).toBe(secondReply);
    expect(
      stripPreviouslyDisplayedAssistantPrefix(secondReply, firstReply)
    ).toBe(secondReply);
  });
});
