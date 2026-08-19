import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';

export type ConversationFindField = 'text' | 'thinking' | 'plan';

export type ConversationFindMatch = {
  rowIndex: number;
  field: ConversationFindField;
  start: number;
  end: number;
};

export function searchableTimelineFields(
  row: ConversationTimelineTurn
): Array<{ field: ConversationFindField; text: string }> {
  const fields: Array<{ field: ConversationFindField; text: string }> = [];
  for (const block of row.turn.blocks) {
    if (block.type === 'text' && block.text) {
      fields.push({ field: 'text', text: block.text });
    } else if (block.type === 'thinking' && block.text) {
      fields.push({ field: 'thinking', text: block.text });
    } else if (block.type === 'plan') {
      for (const entry of block.entries) {
        if (entry.content) {
          fields.push({ field: 'plan', text: entry.content });
        }
      }
    }
  }
  return fields;
}

export function findInConversationTimeline(
  timeline: ConversationTimelineTurn[],
  query: string
): ConversationFindMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: ConversationFindMatch[] = [];
  timeline.forEach((row, rowIndex) => {
    for (const { field, text } of searchableTimelineFields(row)) {
      const haystack = text.toLocaleLowerCase();
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        matches.push({
          rowIndex,
          field,
          start,
          end: start + needle.length,
        });
        from = start + needle.length;
      }
    }
  });
  return matches;
}
