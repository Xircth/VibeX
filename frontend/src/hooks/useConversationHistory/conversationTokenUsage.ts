import type { TokenUsageInfo } from 'shared/types';
import type { ExecutionProcessStateStore } from './types';
import { dateTimestamp } from '@/utils/date';

export function getLatestConversationTokenUsage(
  executionProcessState: ExecutionProcessStateStore
): TokenUsageInfo | null {
  const orderedProcesses = Object.values(executionProcessState).sort(
    (a, b) =>
      dateTimestamp(a.executionProcess.created_at) -
      dateTimestamp(b.executionProcess.created_at)
  );

  for (
    let processIndex = orderedProcesses.length - 1;
    processIndex >= 0;
    processIndex--
  ) {
    const process = orderedProcesses[processIndex];
    for (
      let entryIndex = process.entries.length - 1;
      entryIndex >= 0;
      entryIndex--
    ) {
      const entry = process.entries[entryIndex];
      if (
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'token_usage_info'
      ) {
        return entry.content.entry_type;
      }
    }
  }

  return null;
}
