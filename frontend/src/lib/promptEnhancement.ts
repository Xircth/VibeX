import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';

export type PromptEnhancementContextMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string | null;
};

const DEFAULT_CONTEXT_CHAR_LIMIT = 32_000;
const TOOL_CONTENT_CHAR_LIMIT = 400;

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function summarizeToolEntry(entry: PatchTypeWithKey): string | null {
  if (entry.type !== 'NORMALIZED_ENTRY') return null;
  const entryType = entry.content.entry_type;
  if (entryType.type !== 'tool_use') return null;

  const parts = [`Tool: ${entryType.tool_name}`];
  const action = entryType.action_type.action;
  parts.push(`Action: ${action}`);

  if ('path' in entryType.action_type && entryType.action_type.path) {
    parts.push(`Path: ${entryType.action_type.path}`);
  }

  if ('query' in entryType.action_type && entryType.action_type.query) {
    parts.push(`Query: ${entryType.action_type.query}`);
  }

  if ('command' in entryType.action_type && entryType.action_type.command) {
    parts.push(`Command: ${entryType.action_type.command}`);
  }

  if (entryType.status.status) {
    parts.push(`Status: ${entryType.status.status}`);
  }

  const content = entry.content.content.trim();
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
  const trimmedContent = content.trim();

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
  const normalized = entries
    .map(toContextMessage)
    .filter((entry): entry is PromptEnhancementContextMessage => !!entry);

  const selected: PromptEnhancementContextMessage[] = [];
  let totalChars = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const candidate = normalized[index];
    const candidateSize =
      candidate.role.length +
      candidate.content.length +
      (candidate.timestamp?.length ?? 0) +
      16;

    if (selected.length > 0 && totalChars + candidateSize > maxChars) {
      break;
    }

    selected.push(candidate);
    totalChars += candidateSize;
  }

  return selected.reverse();
}
