import type { NormalizedEntryType } from 'shared/types';
import { describe, expect, it } from 'vitest';
import {
  getConversationSnapshotComparisonKeys,
  isLikelyStaleRunningSnapshot,
} from './conversationSnapshotStaleness';
import type {
  ExecutionProcessState,
  ExecutionProcessStateStore,
  PatchTypeWithKey,
} from './types';

const scriptExecutorAction = {
  typ: {
    type: 'ScriptRequest',
    script: 'echo hello',
    language: 'Bash',
    context: 'SetupScript',
    working_dir: null,
  },
  next_action: null,
} as const;

function normalizedEntry(
  executionProcessId: string,
  index: number,
  entryType: NormalizedEntryType,
  content: string
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: entryType,
      content,
      timestamp: null,
    },
    patchKey: `${executionProcessId}:${index}`,
    executionProcessId,
  };
}

function processState(
  executionProcessId: string,
  entries: PatchTypeWithKey[]
): ExecutionProcessState {
  return {
    executionProcess: {
      id: executionProcessId,
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
      executor_action: scriptExecutorAction,
    },
    entries,
  };
}

describe('conversationSnapshotStaleness', () => {
  it('ignores user, token usage, and loading entries in comparison keys', () => {
    const assistant = normalizedEntry(
      'process-1',
      0,
      { type: 'assistant_message' },
      'assistant output'
    );

    expect(
      getConversationSnapshotComparisonKeys([
        normalizedEntry('process-1', 1, { type: 'user_message' }, 'prompt'),
        normalizedEntry(
          'process-1',
          2,
          {
            type: 'token_usage_info',
            total_tokens: 10,
            model_context_window: 100,
          },
          ''
        ),
        normalizedEntry('process-1', 3, { type: 'loading' }, ''),
        assistant,
      ])
    ).toEqual([
      JSON.stringify({ type: assistant.type, content: assistant.content }),
    ]);
  });

  it('detects a running snapshot duplicated from another process', () => {
    const entries = [
      normalizedEntry(
        'process-2',
        0,
        { type: 'assistant_message' },
        'same assistant output'
      ),
    ];
    const displayed: ExecutionProcessStateStore = {
      'process-1': processState('process-1', [
        normalizedEntry(
          'process-1',
          0,
          { type: 'assistant_message' },
          'same assistant output'
        ),
      ]),
    };

    expect(
      isLikelyStaleRunningSnapshot('process-2', entries, displayed)
    ).toBe(true);
  });

  it('does not compare a process snapshot against itself', () => {
    const entries = [
      normalizedEntry(
        'process-1',
        0,
        { type: 'assistant_message' },
        'same assistant output'
      ),
    ];
    const displayed: ExecutionProcessStateStore = {
      'process-1': processState('process-1', entries),
    };

    expect(
      isLikelyStaleRunningSnapshot('process-1', entries, displayed)
    ).toBe(false);
  });

  it('requires the same ordered comparison sequence', () => {
    const displayed: ExecutionProcessStateStore = {
      'process-1': processState('process-1', [
        normalizedEntry('process-1', 0, { type: 'assistant_message' }, 'a'),
        normalizedEntry('process-1', 1, { type: 'assistant_message' }, 'b'),
      ]),
    };

    expect(
      isLikelyStaleRunningSnapshot(
        'process-2',
        [
          normalizedEntry('process-2', 0, { type: 'assistant_message' }, 'b'),
          normalizedEntry('process-2', 1, { type: 'assistant_message' }, 'a'),
        ],
        displayed
      )
    ).toBe(false);
  });
});
