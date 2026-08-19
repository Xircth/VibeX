import { describe, expect, it } from 'vitest';
import type { ActionType, NormalizedEntry } from 'shared/types';
import type {
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/conversationEntries';
import {
  buildConversationMessageNavEntries,
  findActiveConversationMessageNavEntry,
} from './messageNavEntries';

function entry(
  key: string,
  entryType: NormalizedEntry['entry_type'],
  content: string
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: key,
    executionProcessId: 'process-1',
    content: {
      entry_type: entryType,
      content,
      timestamp: null,
    },
  };
}

function tool(key: string, actionType: ActionType): PatchTypeWithKey {
  return entry(
    key,
    {
      type: 'tool_use',
      tool_name: 'edit',
      action_type: actionType,
      status: { status: 'success' },
    },
    key
  );
}

describe('message nav entries', () => {
  it('builds user anchors with file-change stats until the next user turn', () => {
    const entries: DisplayEntry[] = [
      entry('user-1', { type: 'user_message' }, 'Fix the dashboard'),
      tool('edit-1', {
        action: 'file_edit',
        path: 'src/App.tsx',
        changes: [
          {
            action: 'edit',
            unified_diff: ['@@ -1,3 +1,4 @@', '-old', '+new', '+extra'].join(
              '\n'
            ),
            has_line_numbers: true,
          },
        ],
      }),
      entry('assistant-1', { type: 'assistant_message' }, 'Done'),
      entry('user-2', { type: 'user_message' }, 'Add docs'),
      tool('write-1', {
        action: 'file_edit',
        path: 'README.md',
        changes: [{ action: 'write', content: 'one\ntwo' }],
      }),
    ];

    expect(buildConversationMessageNavEntries(entries)).toEqual([
      {
        key: 'user-1',
        index: 0,
        ordinal: 1,
        preview: 'Fix the dashboard',
        additions: 2,
        deletions: 1,
      },
      {
        key: 'user-2',
        index: 3,
        ordinal: 2,
        preview: 'Add docs',
        additions: 2,
        deletions: 0,
      },
    ]);
  });

  it('selects the latest user anchor above the active virtual row', () => {
    const entries = [
      {
        key: 'user-1',
        index: 0,
        ordinal: 1,
        preview: 'First',
        additions: 0,
        deletions: 0,
      },
      {
        key: 'user-2',
        index: 4,
        ordinal: 2,
        preview: 'Second',
        additions: 0,
        deletions: 0,
      },
    ];

    expect(findActiveConversationMessageNavEntry(entries, 5)?.key).toBe(
      'user-2'
    );
    expect(findActiveConversationMessageNavEntry(entries, 2)?.key).toBe(
      'user-1'
    );
  });
});
