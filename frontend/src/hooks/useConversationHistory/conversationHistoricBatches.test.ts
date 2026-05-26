import { describe, expect, it, vi } from 'vitest';
import {
  BaseCodingAgent,
  ExecutionProcessStatus,
  type ExecutionProcess,
  type PatchType,
} from 'shared/types';
import {
  loadInitialConversationProcessStates,
  loadRemainingConversationProcessStates,
  toConversationProcessState,
} from './conversationHistoricBatches';
import type { ExecutionProcessStateStore } from './types';

function process(
  id: string,
  status = ExecutionProcessStatus.completed
): ExecutionProcess {
  return {
    id,
    session_id: 'session-1',
    run_reason: 'codingagent',
    executor_action: {
      typ: {
        type: 'CodingAgentInitialRequest',
        prompt: id,
        executor_profile_id: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
        },
        working_dir: null,
      },
      next_action: null,
    },
    status,
    exit_code: status === ExecutionProcessStatus.completed ? 0n : null,
    dropped: false,
    started_at: '2026-05-26T00:00:00.000Z',
    completed_at:
      status === ExecutionProcessStatus.running
        ? null
        : '2026-05-26T00:00:05.000Z',
    created_at: `2026-05-26T00:00:0${id.slice(-1)}.000Z`,
    updated_at: '2026-05-26T00:00:05.000Z',
  };
}

function patch(content: string): PatchType {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'assistant_message' },
      content,
      timestamp: null,
    },
  };
}

describe('conversationHistoricBatches', () => {
  it('converts raw patches into keyed process state', () => {
    const processState = toConversationProcessState(process('process-1'), [
      patch('a'),
      patch('b'),
    ]);

    expect(processState).toMatchObject({
      executionProcess: {
        id: 'process-1',
        executor_action: expect.any(Object),
      },
      entries: [
        { patchKey: 'process-1:0', executionProcessId: 'process-1' },
        { patchKey: 'process-1:1', executionProcessId: 'process-1' },
      ],
    });
  });

  it('loads initial processes newest-first in chunks until the entry threshold is exceeded', async () => {
    const processes = [
      process('process-1'),
      process('process-2'),
      process('process-3'),
    ];
    const loadEntries = vi.fn(async (executionProcess: ExecutionProcess) => [
      patch(executionProcess.id),
    ]);

    const state = await loadInitialConversationProcessStates(processes, {
      processConcurrency: 2,
      minInitialEntries: 1,
      loadEntries,
    });

    expect(loadEntries.mock.calls.map(([executionProcess]) => executionProcess.id))
      .toEqual(['process-3', 'process-2']);
    expect(Object.keys(state)).toEqual(['process-3', 'process-2']);
  });

  it('loads only undisplayed non-running remaining processes from the newest chunk', async () => {
    const processes = [
      process('process-1'),
      process('process-2', ExecutionProcessStatus.running),
      process('process-3'),
      process('process-4'),
    ];
    const displayed: ExecutionProcessStateStore = {
      'process-4': toConversationProcessState(process('process-4'), [
        patch('already shown'),
      ]),
    };
    const loadEntries = vi.fn(async (executionProcess: ExecutionProcess) => [
      patch(executionProcess.id),
    ]);

    const result = await loadRemainingConversationProcessStates(
      processes,
      displayed,
      {
        processConcurrency: 2,
        batchSize: 10,
        loadEntries,
      }
    );

    expect(loadEntries.mock.calls.map(([executionProcess]) => executionProcess.id))
      .toEqual(['process-3', 'process-1']);
    expect(Object.keys(result.loadedStates)).toEqual([
      'process-3',
      'process-1',
    ]);
    expect(result.shouldContinue).toBe(true);
  });

  it('returns no-op remaining result when nothing is eligible', async () => {
    const displayed: ExecutionProcessStateStore = {
      'process-1': toConversationProcessState(process('process-1'), [
        patch('already shown'),
      ]),
    };
    const loadEntries = vi.fn(async () => [patch('unused')]);

    const result = await loadRemainingConversationProcessStates(
      [process('process-1'), process('process-2', ExecutionProcessStatus.running)],
      displayed,
      {
        processConcurrency: 2,
        batchSize: 10,
        loadEntries,
      }
    );

    expect(loadEntries).not.toHaveBeenCalled();
    expect(result).toEqual({
      loadedStates: {},
      shouldContinue: false,
    });
  });
});
