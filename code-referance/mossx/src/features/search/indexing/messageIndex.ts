import type { ConversationItem } from "../../../types";

export type IndexedMessage = {
  messageId: string;
  threadId: string;
  text: string;
};

export function buildWorkspaceMessageIndex(
  threadIds: string[],
  itemsByThread: Record<string, ConversationItem[]>,
): IndexedMessage[] {
  const indexed: IndexedMessage[] = [];
  for (const threadId of threadIds) {
    const items = itemsByThread[threadId] ?? [];
    for (const item of items) {
      if (item.kind !== "message") {
        continue;
      }
      const text = item.text.trim();
      if (!text) {
        continue;
      }
      indexed.push({
        messageId: item.id,
        threadId,
        text,
      });
    }
  }
  return indexed;
}

export function makeMessageSnippet(text: string, query: string, radius = 36): string {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return text.slice(0, Math.min(96, text.length));
  }
  const lower = text.toLowerCase();
  const hit = lower.indexOf(normalizedQuery);
  if (hit < 0) {
    return text.slice(0, Math.min(96, text.length));
  }
  const start = Math.max(0, hit - radius);
  const end = Math.min(text.length, hit + normalizedQuery.length + radius);
  const head = start > 0 ? "..." : "";
  const tail = end < text.length ? "..." : "";
  return `${head}${text.slice(start, end)}${tail}`;
}
