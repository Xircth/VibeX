import type { ConversationMessageNavEntry } from '@/components/conversation-thread/messageNavEntries';

import { isCollabThreadUserBubble } from './collaborationThreadLog';
import { bubbleText } from './SpaceMessageBody';
import type { SpaceEnvelopeParties } from './spaceModel';

export function buildCollaborationUserMessageNavEntries(
  messages: ReadonlyArray<{
    seq: number;
    origin?: string;
    envelope?: (SpaceEnvelopeParties & { content?: string }) | null;
  }>
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  messages.forEach((message, index) => {
    if (!isCollabThreadUserBubble(message)) return;
    const text = bubbleText(message.envelope ?? {});
    const singleLine = text.replace(/\s+/g, ' ').trim();
    const ordinal = entries.length + 1;
    entries.push({
      key: `space-msg-${message.seq}`,
      index,
      ordinal,
      preview:
        singleLine.length > 80
          ? `${singleLine.slice(0, 80)}…`
          : singleLine || `Message ${ordinal}`,
      additions: 0,
      deletions: 0,
    });
  });
  return entries;
}
