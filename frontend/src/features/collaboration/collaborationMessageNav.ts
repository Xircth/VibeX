import type { ConversationMessageNavEntry } from '@/components/conversation-thread/messageNavEntries';

import { bubbleText } from './SpaceMessageBody';
import { COPY, isCollaborationLimitNotice, messageAuthor } from './spaceModel';

export function buildCollaborationUserMessageNavEntries(
  messages: ReadonlyArray<{
    seq: number;
    origin?: string;
    envelope?: {
      actor?: string;
      content?: string;
      summary?: string;
    } | null;
  }>
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  messages.forEach((message, index) => {
    if (isCollaborationLimitNotice(message)) return;
    if (messageAuthor(message.envelope) !== COPY.you) return;
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
