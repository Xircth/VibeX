import type {
  ExecutionProcessStateStore,
  PatchTypeWithKey,
} from './types';

export function getConversationSnapshotComparisonKeys(
  entries: PatchTypeWithKey[]
): string[] {
  return entries
    .map((entry) => {
      if (entry.type !== 'NORMALIZED_ENTRY') {
        return JSON.stringify({ type: entry.type, content: entry.content });
      }

      const entryType = entry.content.entry_type.type;
      if (
        entryType === 'user_message' ||
        entryType === 'token_usage_info' ||
        entryType === 'loading'
      ) {
        return null;
      }

      return JSON.stringify({
        type: entry.type,
        content: entry.content,
      });
    })
    .filter((key): key is string => Boolean(key));
}

export function isLikelyStaleRunningSnapshot(
  executionProcessId: string,
  entries: PatchTypeWithKey[],
  displayedExecutionProcesses: ExecutionProcessStateStore
): boolean {
  const nextKeys = getConversationSnapshotComparisonKeys(entries);
  if (nextKeys.length === 0) {
    return false;
  }

  return Object.entries(displayedExecutionProcesses).some(
    ([otherProcessId, state]) => {
      if (otherProcessId === executionProcessId) {
        return false;
      }

      const existingKeys = getConversationSnapshotComparisonKeys(state.entries);
      return (
        existingKeys.length === nextKeys.length &&
        existingKeys.every((key, index) => key === nextKeys[index])
      );
    }
  );
}
