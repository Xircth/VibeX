import type { FileChange } from 'shared/types';
import type {
  BaseDisplayEntry,
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';
import { isCollapsedAssistantMessagesGroup } from '@/hooks/useConversationHistory/types';
import { parseDiffStats } from '@/utils/diffStatsParser';

export type ConversationMessageNavEntry = {
  key: string;
  index: number;
  ordinal: number;
  preview: string;
  additions: number;
  deletions: number;
};

function isUserMessageEntry(
  entry: DisplayEntry | BaseDisplayEntry
): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } {
  return (
    entry.type === 'NORMALIZED_ENTRY' &&
    entry.content.entry_type.type === 'user_message'
  );
}

function normalizedPreview(content: string, ordinal: number): string {
  const preview = content.trim().replace(/\s+/g, ' ').slice(0, 80);
  return preview || `User message ${ordinal}`;
}

function statsForChange(change: FileChange): {
  additions: number;
  deletions: number;
} {
  switch (change.action) {
    case 'edit':
      return parseDiffStats(change.unified_diff);
    case 'write':
      return {
        additions: Math.max(1, change.content.split(/\r?\n/).length),
        deletions: 0,
      };
    case 'delete':
      return { additions: 0, deletions: 1 };
    case 'rename':
      return { additions: 0, deletions: 0 };
  }
}

function statsForPatchEntry(entry: PatchTypeWithKey): {
  additions: number;
  deletions: number;
} {
  if (
    entry.type !== 'NORMALIZED_ENTRY' ||
    entry.content.entry_type.type !== 'tool_use' ||
    entry.content.entry_type.action_type.action !== 'file_edit'
  ) {
    return { additions: 0, deletions: 0 };
  }

  return entry.content.entry_type.action_type.changes.reduce(
    (total, change) => {
      const stats = statsForChange(change);
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 }
  );
}

function statsForBaseEntry(entry: BaseDisplayEntry): {
  additions: number;
  deletions: number;
} {
  if (
    entry.type === 'AGGREGATED_FILE_EDIT_GROUP' ||
    entry.type === 'PROCESS_CHANGE_SUMMARY' ||
    entry.type === 'AGGREGATED_GROUP'
  ) {
    return entry.entries.reduce(
      (total, child) => {
        const stats = statsForPatchEntry(child);
        return {
          additions: total.additions + stats.additions,
          deletions: total.deletions + stats.deletions,
        };
      },
      { additions: 0, deletions: 0 }
    );
  }

  if (entry.type === 'AGGREGATED_THINKING_GROUP') {
    return { additions: 0, deletions: 0 };
  }

  return statsForPatchEntry(entry);
}

function statsForDisplayEntry(entry: DisplayEntry): {
  additions: number;
  deletions: number;
} {
  if (isCollapsedAssistantMessagesGroup(entry)) {
    return entry.entries.reduce(
      (total, child) => {
        const stats = statsForBaseEntry(child);
        return {
          additions: total.additions + stats.additions,
          deletions: total.deletions + stats.deletions,
        };
      },
      { additions: 0, deletions: 0 }
    );
  }

  return statsForBaseEntry(entry);
}

export function buildConversationMessageNavEntries(
  entries: DisplayEntry[]
): ConversationMessageNavEntry[] {
  // Single pass: each user message starts a new nav entry that accumulates the
  // file-change stats of the entries following it, up to the next user message.
  const navEntries: ConversationMessageNavEntry[] = [];
  let current: ConversationMessageNavEntry | null = null;

  entries.forEach((entry, index) => {
    if (isUserMessageEntry(entry)) {
      const ordinal = navEntries.length + 1;
      current = {
        key: entry.patchKey,
        index,
        ordinal,
        preview: normalizedPreview(entry.content.content, ordinal),
        additions: 0,
        deletions: 0,
      };
      navEntries.push(current);
      return;
    }

    if (current) {
      const stats = statsForDisplayEntry(entry);
      current.additions += stats.additions;
      current.deletions += stats.deletions;
    }
  });

  return navEntries;
}

export function findActiveConversationMessageNavEntry(
  entries: ConversationMessageNavEntry[],
  activeIndex: number | null
): ConversationMessageNavEntry | null {
  if (entries.length === 0) return null;
  if (activeIndex === null) return entries[0]!;

  let active = entries[0]!;
  for (const entry of entries) {
    if (entry.index > activeIndex) {
      break;
    }
    active = entry;
  }

  return active;
}
