import type { AddEntryType, PatchTypeWithKey } from './types';

export function getConversationEmitAddType(
  entries: PatchTypeWithKey[],
  requestedAddType: AddEntryType
): AddEntryType {
  if (entries.length === 0) {
    return requestedAddType;
  }

  const lastEntry = entries[entries.length - 1];
  if (
    lastEntry.type === 'NORMALIZED_ENTRY' &&
    lastEntry.content.entry_type.type === 'tool_use' &&
    lastEntry.content.entry_type.tool_name === 'ExitPlanMode'
  ) {
    return 'plan';
  }

  return requestedAddType;
}
