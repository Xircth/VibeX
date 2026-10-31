import type { ConversationMessageNavEntry } from '@/components/conversation-thread/messageNavEntries';

import { isCollabThreadUserBubble } from './collaborationThreadLog';
import { bubbleText } from './SpaceMessageBody';
import type { SpaceEnvelopeParties } from './spaceModel';

export type SpaceMessageRefTarget = {
  seq: number;
  id?: string | null;
  envelope?: { id?: unknown } | null;
};

export function spaceMessageRefKey(message: SpaceMessageRefTarget): string {
  return (
    String(message.id ?? message.envelope?.id ?? '').trim() ||
    String(message.seq)
  );
}

export function buildCollaborationUserMessageNavEntries(
  messages: ReadonlyArray<{
    seq: number;
    id?: string | null;
    origin?: string;
    envelope?: (SpaceEnvelopeParties & { id?: unknown; content?: string }) | null;
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

