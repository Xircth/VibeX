import { describe, expect, it } from 'vitest';
import type { ConversationDelegationView, MessageTurn } from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  hostDelegationToolUseIds,
  matchHostDelegationView,
  mergeHostDelegationView,
  shouldInlineDelegationSideRow,
} from './hostDelegation';

function use(
  toolName: string,
  input: unknown,
  toolUseId = 'tool-1'
): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: toolUseId,
    tool_name: toolName,
    kind: null,
    input_preview: JSON.stringify(input),
    meta: null,
  };
}

function result(
  output: string,
  isError = false,
  toolUseId = 'tool-1'
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    output_preview: output,
    is_error: isError,
    agent_stats: null,
  };
}

describe('hostDelegation', () => {
  it('collects only host MCP spawn tool ids from turns', () => {
    const turns = [
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: '2026-08-18T00:00:00.000Z',
        blocks: [
          use('delegate_to_agent', { agent_type: 'codex', task: 'review' }),
          use(
            'spawn_subagent',
            { subagent_type: 'explore', prompt: 'look' },
            'native-1'
          ),
          use('bash', { command: 'ls' }, 'bash-1'),
        ],
      },
    ] as MessageTurn[];

    expect([...hostDelegationToolUseIds(turns)]).toEqual(['tool-1']);
  });

  it('builds a running product view from the MCP tool call before the event arrives', () => {
    const view = mergeHostDelegationView(
      use('delegate_to_agent', { agent_type: 'grok', task: 'Review the diff' }),
      result('{"task_id":"task-1","status":"running"}'),
      null
    );

    expect(view.agent_id).toBe('grok');
    expect(view.task_preview).toBe('Review the diff');
    expect(view.status).toBe('running');
    expect(view.child_conversation_id).toBeNull();
    expect(view.parent_tool_call_id).toBe('tool-1');
  });

  it('lets the conversation event win for child id, status, and result', () => {
    const event: ConversationDelegationView = {
      delegation_id: 'delegation-1',
      parent_tool_call_id: 'tool-1',
      child_conversation_id: 'child-1',
      agent_id: 'codex' as const,
      task_preview: 'Review the diff',
      status: 'completed',
      result: { kind: 'ok', text_preview: 'done', duration_ms: 2100n },
    };

    expect(
      mergeHostDelegationView(
        use('delegate_to_agent', {
          agent_type: 'grok',
          task: 'Review the diff',
        }),
        result('{"task_id":"task-1","status":"running"}'),
        event
      )
    ).toEqual(event);
    expect(matchHostDelegationView(use('delegate_to_agent', {}), [event])).toBe(
      event
    );
  });

  it('hides the event side row once the MCP tool already occupies the turn', () => {
    const occupied = new Set(['tool-1']);
    expect(shouldInlineDelegationSideRow('tool-1', occupied)).toBe(false);
    expect(shouldInlineDelegationSideRow(null, occupied)).toBe(false);
    expect(shouldInlineDelegationSideRow('tool-2', occupied)).toBe(true);
    expect(shouldInlineDelegationSideRow('tool-1', new Set())).toBe(true);
  });
});
