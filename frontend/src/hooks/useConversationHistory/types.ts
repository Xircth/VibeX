import { ExecutorAction, PatchType } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';

export type PatchTypeWithKey = PatchType & {
  patchKey: string;
  executionProcessId: string;
};

/**
 * A group of consecutive entries of the same aggregatable type (e.g., file_read, search, web_fetch).
 * Used to display multiple read/search/fetch operations in a collapsed accordion style.
 */
export type AggregatedPatchGroup = {
  type: 'AGGREGATED_GROUP';
  /** The aggregation category (e.g., 'file_read', 'search', 'web_fetch', 'command_run') */
  aggregationType: 'file_read' | 'search' | 'web_fetch' | 'command_run';
  /** The individual entries in this group */
  entries: PatchTypeWithKey[];
  /** Unique key for the group */
  patchKey: string;
  executionProcessId: string;
};

/**
 * A group of consecutive file_edit tool calls.
 * Used to display multiple edit operations in a collapsed accordion style.
 */
export type AggregatedFileEditGroup = {
  type: 'AGGREGATED_FILE_EDIT_GROUP';
  /** The individual file_edit entries in this group */
  entries: PatchTypeWithKey[];
  /** Unique key for the group */
  patchKey: string;
  executionProcessId: string;
};

/**
 * A final summary of all file changes made by one completed execution process.
 * Used for the per-turn "files changed" preview after the assistant output ends.
 */
export type ProcessChangeSummaryGroup = {
  type: 'PROCESS_CHANGE_SUMMARY';
  /** The file_edit entries collected across the entire process */
  entries: PatchTypeWithKey[];
  /** Unique key for the summary */
  patchKey: string;
  executionProcessId: string;
};

/**
 * A group of thinking entries from a previous conversation turn.
 * Used to collapse thinking steps in previous answers for cleaner display.
 */
export type AggregatedThinkingGroup = {
  type: 'AGGREGATED_THINKING_GROUP';
  /** The individual thinking entries in this group */
  entries: PatchTypeWithKey[];
  /** Unique key for the group */
  patchKey: string;
  executionProcessId: string;
};

export type DisplayEntry =
  | PatchTypeWithKey
  | AggregatedPatchGroup
  | AggregatedFileEditGroup
  | ProcessChangeSummaryGroup
  | AggregatedThinkingGroup;

export function isAggregatedGroup(
  entry: DisplayEntry
): entry is AggregatedPatchGroup {
  return entry.type === 'AGGREGATED_GROUP';
}

export function isAggregatedFileEditGroup(
  entry: DisplayEntry
): entry is AggregatedFileEditGroup {
  return entry.type === 'AGGREGATED_FILE_EDIT_GROUP';
}

export function isProcessChangeSummaryGroup(
  entry: DisplayEntry
): entry is ProcessChangeSummaryGroup {
  return entry.type === 'PROCESS_CHANGE_SUMMARY';
}

export function isAggregatedThinkingGroup(
  entry: DisplayEntry
): entry is AggregatedThinkingGroup {
  return entry.type === 'AGGREGATED_THINKING_GROUP';
}

export type AddEntryType = 'initial' | 'running' | 'historic' | 'plan';

export type OnEntriesUpdated = (
  newEntries: PatchTypeWithKey[],
  addType: AddEntryType,
  loading: boolean
) => void;

export type ExecutionProcessStaticInfo = {
  id: string;
  created_at: string;
  updated_at: string;
  executor_action: ExecutorAction;
};

export type ExecutionProcessState = {
  executionProcess: ExecutionProcessStaticInfo;
  entries: PatchTypeWithKey[];
};

export type ExecutionProcessStateStore = Record<string, ExecutionProcessState>;

export interface UseConversationHistoryParams {
  attempt: WorkspaceWithSession;
  onEntriesUpdated: OnEntriesUpdated;
}

export interface UseConversationHistoryResult {}
