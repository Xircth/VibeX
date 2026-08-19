import { describe, expect, it } from 'vitest';
import {
  agentUsageToSnapshot,
  agentUsageToTokenUsageInfo,
  getLatestConversationTokenUsage,
} from './conversationTokenUsage';
import type { ExecutionProcessStateStore, PatchTypeWithKey } from './conversationEntries';

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

function tokenUsageEntry(
  executionProcessId: string,
  index: number,
  totalTokens: number
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: {
        type: 'token_usage_info',
        total_tokens: totalTokens,
        model_context_window: 1000,
      },
      content: '',
      timestamp: null,
    },
    patchKey: `${executionProcessId}:${index}`,
    executionProcessId,
  };
}

function assistantEntry(
  executionProcessId: string,
  index: number
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'assistant_message' },
      content: 'assistant output',
      timestamp: null,
    },
    patchKey: `${executionProcessId}:${index}`,
    executionProcessId,
  };
}

function processState(
  executionProcessId: string,
  createdAt: string,
  entries: PatchTypeWithKey[]
) {
  return {
    executionProcess: {
      id: executionProcessId,
      created_at: createdAt,
      updated_at: createdAt,
      executor_action: scriptExecutorAction,
    },
    entries,
  };
}

describe('conversationTokenUsage', () => {
  it('returns null when no token usage entry exists', () => {
    const store: ExecutionProcessStateStore = {
      'process-1': processState('process-1', '2026-03-22T00:00:00.000Z', [
        assistantEntry('process-1', 0),
      ]),
    };

    expect(getLatestConversationTokenUsage(store)).toBeNull();
  });

  it('uses the latest process by creation time regardless of object order', () => {
    const store: ExecutionProcessStateStore = {
      'process-newer': processState(
        'process-newer',
        '2026-03-22T00:00:05.000Z',
        [tokenUsageEntry('process-newer', 0, 30)]
      ),
      'process-older': processState(
        'process-older',
        '2026-03-22T00:00:00.000Z',
        [tokenUsageEntry('process-older', 0, 90)]
      ),
    };

    expect(getLatestConversationTokenUsage(store)).toEqual({
      type: 'token_usage_info',
      total_tokens: 30,
      model_context_window: 1000,
    });
  });

  it('uses the last token usage entry within the newest matching process', () => {
    const store: ExecutionProcessStateStore = {
      'process-1': processState('process-1', '2026-03-22T00:00:00.000Z', [
        tokenUsageEntry('process-1', 0, 10),
        assistantEntry('process-1', 1),
        tokenUsageEntry('process-1', 2, 20),
      ]),
    };

    expect(getLatestConversationTokenUsage(store)?.total_tokens).toBe(20);
  });

  it('falls back to an older process when newer processes have no token usage', () => {
    const store: ExecutionProcessStateStore = {
      'process-newer': processState(
        'process-newer',
        '2026-03-22T00:00:05.000Z',
        [assistantEntry('process-newer', 0)]
      ),
      'process-older': processState(
        'process-older',
        '2026-03-22T00:00:00.000Z',
        [tokenUsageEntry('process-older', 0, 70)]
      ),
    };

    expect(getLatestConversationTokenUsage(store)?.total_tokens).toBe(70);
  });

  it('normalizes Agent usage events into token usage snapshots', () => {
    expect(agentUsageToTokenUsageInfo({ used: 42n, limit: 100n })).toEqual({
      total_tokens: 42,
      model_context_window: 100,
    });

    expect(agentUsageToSnapshot({ used: 42, limit: null })).toEqual({
      totalTokens: 42,
      contextWindow: 42,
    });
  });
});
