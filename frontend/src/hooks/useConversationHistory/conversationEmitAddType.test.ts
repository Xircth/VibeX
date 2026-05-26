import { describe, expect, it } from 'vitest';
import { getConversationEmitAddType } from './conversationEmitAddType';
import type { AddEntryType, PatchTypeWithKey } from './types';

function toolUseEntry(toolName: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: {
        type: 'tool_use',
        tool_name: toolName,
        action_type: {
          action: 'command_run',
          command: toolName,
          result: {
            output: '',
            exit_status: null,
          },
        },
        status: { status: 'success' },
      },
      content: toolName,
      timestamp: null,
    },
    patchKey: `process-1:${toolName}`,
    executionProcessId: 'process-1',
  };
}

function assistantEntry(): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'assistant_message' },
      content: 'done',
      timestamp: null,
    },
    patchKey: 'process-1:assistant',
    executionProcessId: 'process-1',
  };
}

describe('conversationEmitAddType', () => {
  it.each<AddEntryType>(['initial', 'running', 'historic', 'plan'])(
    'preserves %s for empty entry batches',
    (addType) => {
      expect(getConversationEmitAddType([], addType)).toBe(addType);
    }
  );

  it('preserves the requested add type when the last entry is not ExitPlanMode', () => {
    expect(
      getConversationEmitAddType([toolUseEntry('Read')], 'running')
    ).toBe('running');
    expect(getConversationEmitAddType([assistantEntry()], 'historic')).toBe(
      'historic'
    );
  });

  it.each<AddEntryType>(['initial', 'running', 'historic', 'plan'])(
    'returns plan for %s batches ending in ExitPlanMode',
    (addType) => {
      expect(
        getConversationEmitAddType(
          [assistantEntry(), toolUseEntry('ExitPlanMode')],
          addType
        )
      ).toBe('plan');
    }
  );
});
