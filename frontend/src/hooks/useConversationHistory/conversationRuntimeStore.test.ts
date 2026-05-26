import { ExecutionProcessStatus } from 'shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConversationRuntimeForTests,
  createConversationStreamId,
  getConversationRuntimeState,
  MAX_CONVERSATION_RUNTIME_ENTRIES,
  rememberConversationHistoryState,
} from './conversationRuntimeStore';
import type { ExecutionProcessStateStore } from './types';

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

describe('conversationRuntimeStore', () => {
  beforeEach(() => {
    clearConversationRuntimeForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a cloned runtime snapshot when requested', () => {
    const displayedExecutionProcesses: ExecutionProcessStateStore = {
      'process-1': {
        executionProcess: {
          id: 'process-1',
          created_at: '2026-03-22T00:00:00.000Z',
          updated_at: '2026-03-22T00:00:00.000Z',
          executor_action: scriptExecutorAction,
        },
        entries: [],
      },
    };
    const previousStatusMap = new Map([
      ['process-1', ExecutionProcessStatus.running],
    ]);

    rememberConversationHistoryState(
      'conversation-1',
      displayedExecutionProcesses,
      'process-1',
      previousStatusMap,
      { clone: true }
    );

    displayedExecutionProcesses['process-1'].entries.push({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: { type: 'assistant_message' },
        content: 'mutated later',
        timestamp: null,
      },
      patchKey: 'process-1:0',
      executionProcessId: 'process-1',
    });
    previousStatusMap.set('process-1', ExecutionProcessStatus.completed);

    const runtime = getConversationRuntimeState('conversation-1');
    expect(runtime?.displayedExecutionProcesses['process-1'].entries).toEqual(
      []
    );
    expect(runtime?.previousStatusMap).toEqual([
      ['process-1', ExecutionProcessStatus.running],
    ]);
  });

  it('stores the live runtime state reference when cloning is disabled', () => {
    const displayedExecutionProcesses: ExecutionProcessStateStore = {};

    rememberConversationHistoryState(
      'conversation-1',
      displayedExecutionProcesses,
      '',
      new Map(),
      { clone: false }
    );

    displayedExecutionProcesses['process-1'] = {
      executionProcess: {
        id: 'process-1',
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
        executor_action: scriptExecutorAction,
      },
      entries: [],
    };

    expect(
      getConversationRuntimeState('conversation-1')?.displayedExecutionProcesses
    ).toBe(displayedExecutionProcesses);
    expect(
      getConversationRuntimeState('conversation-1')
        ?.displayedExecutionProcesses['process-1']
    ).toBeDefined();
  });

  it('evicts the oldest runtime entries after the retention limit', () => {
    for (let index = 0; index <= MAX_CONVERSATION_RUNTIME_ENTRIES; index += 1) {
      rememberConversationHistoryState(
        `conversation-${index}`,
        {},
        '',
        new Map(),
        { clone: false }
      );
    }

    expect(getConversationRuntimeState('conversation-0')).toBeUndefined();
    expect(getConversationRuntimeState('conversation-1')).toBeDefined();
    expect(
      getConversationRuntimeState(
        `conversation-${MAX_CONVERSATION_RUNTIME_ENTRIES}`
      )
    ).toBeDefined();
  });

  it('creates unique stream ids that include the execution process id', () => {
    vi.setSystemTime(new Date('2026-03-22T00:00:00.000Z'));

    expect(createConversationStreamId('process-1')).toMatch(/^process-1:/);
    expect(createConversationStreamId('process-1')).not.toEqual(
      createConversationStreamId('process-1')
    );
  });
});
