import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

export function createLongConversationFixture(
  messageCount = 1000
): PatchTypeWithKey[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const isUserMessage = index % 2 === 0;
    const turnIndex = Math.floor(index / 2);

    return {
      type: 'NORMALIZED_ENTRY',
      patchKey: `long-conversation:${index}`,
      executionProcessId: `long-conversation-turn:${turnIndex}`,
      content: {
        entry_type: {
          type: isUserMessage ? 'user_message' : 'assistant_message',
        },
        content: isUserMessage
          ? `Inspect item ${turnIndex}`
          : `Result ${turnIndex}\n\n- changed files: ${turnIndex % 7}\n- status: ready`,
        timestamp: null,
      },
    };
  });
}
