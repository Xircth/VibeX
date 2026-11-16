import type { PatchTypeWithKey } from '@/hooks/conversationEntries';

export type PromptEnhancementContextMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string | null;
};

const DEFAULT_CONTEXT_CHAR_LIMIT = 32_000;
const TOOL_CONTENT_CHAR_LIMIT = 400;

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return '…';
  return `${text.slice(0, maxLength - 1)}…`;
}

function summarizeToolEntry(entry: PatchTypeWithKey): string | null {
  if (entry.type !== 'NORMALIZED_ENTRY') return null;
  const entryType = entry.content.entry_type;
  if (entryType.type !== 'tool_use') return null;

  const parts = [`Tool: ${entryType.tool_name}`];
  const actionType = entryType.action_type;
  if (actionType?.action) {
    parts.push(`Action: ${actionType.action}`);
  }

  if (actionType && 'path' in actionType && actionType.path) {
    parts.push(`Path: ${actionType.path}`);
  }

  if (actionType && 'query' in actionType && actionType.query) {
    parts.push(`Query: ${actionType.query}`);
  }

  if (actionType && 'command' in actionType && actionType.command) {
    parts.push(`Command: ${actionType.command}`);
  }

  if (entryType.status?.status) {
    parts.push(`Status: ${entryType.status.status}`);
  }

  const content = (entry.content.content ?? '').trim();
  if (content) {
    parts.push(`Note: ${truncateText(content, TOOL_CONTENT_CHAR_LIMIT)}`);
  }

  return parts.join('\n');
}

function toContextMessage(
  entry: PatchTypeWithKey
): PromptEnhancementContextMessage | null {
  if (entry.type !== 'NORMALIZED_ENTRY') return null;

  const { entry_type: entryType, content, timestamp } = entry.content;
  const trimmedContent = (content ?? '').trim();

  switch (entryType.type) {
    case 'user_message':
      return trimmedContent
        ? { role: 'user', content: trimmedContent, timestamp }
        : null;
    case 'assistant_message':
      return trimmedContent
        ? { role: 'assistant', content: trimmedContent, timestamp }
        : null;
    case 'system_message':
      return trimmedContent
        ? { role: 'system', content: trimmedContent, timestamp }
        : null;
    case 'error_message':
      return trimmedContent
        ? {
            role: 'system',
            content: `[Error] ${trimmedContent}`,
            timestamp,
          }
        : null;
    case 'user_feedback':
      return trimmedContent
        ? {
            role: 'system',
            content: `[UserFeedback] ${trimmedContent}`,
            timestamp,
          }
        : null;
    case 'tool_use': {
      const summary = summarizeToolEntry(entry);
      return summary ? { role: 'tool', content: summary, timestamp } : null;
    }
    default:
      return null;
  }
}

export function buildPromptEnhancementContext(
  entries: PatchTypeWithKey[],
  maxChars = DEFAULT_CONTEXT_CHAR_LIMIT
): PromptEnhancementContextMessage[] {
  if (maxChars <= 0) return [];

  const normalized = entries
    .map(toContextMessage)
    .filter((entry): entry is PromptEnhancementContextMessage => !!entry);

  const selected: PromptEnhancementContextMessage[] = [];
  let totalChars = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const candidate = normalized[index];
    const overhead =
      candidate.role.length + (candidate.timestamp?.length ?? 0) + 16;
    const candidateSize = overhead + candidate.content.length;

    if (selected.length > 0 && totalChars + candidateSize > maxChars) {
      break;
    }

    if (selected.length === 0 && candidateSize > maxChars) {
      const availableContent = maxChars - overhead;
      if (availableContent <= 0) break;
      const truncatedContent = truncateText(
        candidate.content,
        availableContent
      );
      if (!truncatedContent) break;
      selected.push({
        ...candidate,
        content: truncatedContent,
      });
      totalChars += overhead + truncatedContent.length;
      continue;
    }

    selected.push(candidate);
    totalChars += candidateSize;
  }

  return selected.reverse();
}
