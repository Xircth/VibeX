import { describe, expect, it } from 'vitest';
import type { ConversationDelegationView, MessageTurn } from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  hostDelegationLifecycleStatus,
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

  it('reads the child session id from a running MCP ack', () => {
    const view = mergeHostDelegationView(
      use('delegate_to_agent', {
        agent_type: 'codex',
        task: 'introduce yourself',
      }),
      result(
        JSON.stringify({
          task_id: 'task-1',
          status: 'running',
          child_session_id: 'child-from-ack',
        })
      ),
      null
    );
    expect(view.child_conversation_id).toBe('child-from-ack');
    expect(view.status).toBe('running');
  });

  it('prefers the full tool-input task over a truncated started preview', () => {
    const task =
      'Please introduce yourself to the user in Chinese. Goal: Write a brief self-introduction as Codex (OpenAI Codex). This is a social/intro request, not a coding task. Do not modify any files, run commands, or use tools.';
    const view = mergeHostDelegationView(
      use('delegate_to_agent', { agent_type: 'codex', task }),
      null,
      {
        delegation_id: 'd1',
        parent_tool_call_id: 'tool-1',
        child_conversation_id: 'child-1',
        agent_id: 'codex' as const,
        task_preview: `${task.slice(0, 200)}…`,
        status: 'running',
        result: null,
      }
    );
    expect(view.task_preview).toBe(task);
  });

  it('matches a truncated task preview from the started event', () => {
    const task =
      'Please introduce yourself. Write a brief self-introduction in Chinese covering who you are, what you are good at, and how you typically work. Keep it to 3-6 sentences.';
    const event: ConversationDelegationView = {
      delegation_id: 'd1',
      parent_tool_call_id: 'delegation-abc',
      child_conversation_id: 'child-1',
      agent_id: 'codex' as const,
      task_preview: `${task.slice(0, 200)}…`,
      status: 'running',
      result: null,
    };
    expect(
      matchHostDelegationView(
        use('delegate_to_agent', { agent_type: 'codex', task }),
        [event]
      )
    ).toBe(event);
  });

  it('replaces a truncated completed preview with the poll task text', () => {
    const full =
      '你好，我是 Codex，OpenAI 的编程助手。我擅长阅读现有代码、编写和修改实现、运行测试，并在动手前先说明我打算做什么。';
    const truncated = `${full.slice(0, 40)}...`;
    const view = mergeHostDelegationView(
      use('delegate_to_agent', {
        agent_type: 'codex',
        task: 'introduce yourself',
      }),
      result(
        JSON.stringify({
          task_id: 'task-1',
          status: 'running',
          child_session_id: 'child-1',
        })
      ),
      {
        delegation_id: 'd1',
        parent_tool_call_id: 'tool-1',
        child_conversation_id: 'child-1',
        agent_id: 'codex' as const,
        task_preview: 'introduce yourself',
        status: 'completed',
        result: { kind: 'ok', text_preview: truncated, duration_ms: 0n },
      },
      [
        result(
          JSON.stringify({
            tasks: [
              {
                task_id: 'task-1',
                status: 'completed',
                text: full,
                duration_ms: 5589,
                child_session_id: 'child-1',
              },
            ],
          }),
          false,
          'poll-1'
        ),
      ]
    );

    expect(view.status).toBe('completed');
    expect(view.result).toEqual({
      kind: 'ok',
      text_preview: full,
      duration_ms: 5589n,
    });
  });

  it('completes a running spawn from a sibling poll when no event has arrived', () => {
    const full = 'The tests pass and the change is ready.';
    const view = mergeHostDelegationView(
      use('delegate_to_agent', { agent_type: 'codex', task: 'run tests' }),
      result(
        JSON.stringify({
          task_id: 'task-9',
          status: 'running',
          child_session_id: 'child-9',
        })
      ),
      null,
      [
        result(
          JSON.stringify({
            tasks: [
              {
                task_id: 'task-9',
                status: 'completed',
                text: full,
                duration_ms: 1500,
                child_session_id: 'child-9',
              },
            ],
          }),
          false,
          'poll-9'
        ),
      ]
    );

    expect(view.status).toBe('completed');
    expect(view.child_conversation_id).toBe('child-9');
    expect(view.result).toEqual({
      kind: 'ok',
      text_preview: full,
      duration_ms: 1500n,
    });
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

  it('reads poll status from the task list instead of the raw payload', () => {
    expect(hostDelegationLifecycleStatus(null)).toBe('running');
    expect(
      hostDelegationLifecycleStatus(
        result(
          JSON.stringify({
            tasks: [
              {
                status: 'completed',
                text: '你好，我是 Codex',
              },
            ],
          })
        )
      )
    ).toBe('completed');
    expect(
      hostDelegationLifecycleStatus(
        result(JSON.stringify({ tasks: [{ status: 'running' }] }))
      )
    ).toBe('running');
  });

  it('never shows a host-delegation event as a timeline side row', () => {
    const occupied = new Set(['tool-1']);
    expect(shouldInlineDelegationSideRow('tool-1', occupied)).toBe(false);
    expect(shouldInlineDelegationSideRow(null, occupied)).toBe(false);
    expect(shouldInlineDelegationSideRow('tool-2', occupied)).toBe(false);
    expect(shouldInlineDelegationSideRow('tool-1', new Set())).toBe(false);
  });

  it('peels Grok use_tool envelopes and binds synthetic parent ids', () => {
    const grokUse = use(
      'use_tool',
      {
        tool_name: 'vibex-delegation-mcp__delegate_to_agent',
        tool_input: { agent_type: 'codex', task: 'introduce yourself' },
      },
      'call-grok'
    );
    const view = mergeHostDelegationView(grokUse, null, null);
    expect(view.agent_id).toBe('codex');
    expect(view.task_preview).toBe('introduce yourself');
    expect(view.status).toBe('running');

    const event: ConversationDelegationView = {
      delegation_id: 'd1',
      parent_tool_call_id: 'delegation-abc',
      child_conversation_id: 'child-1',
      agent_id: 'codex' as const,
      task_preview: 'introduce yourself',
      status: 'running',
      result: null,
    };
    expect(matchHostDelegationView(grokUse, [event])).toBe(event);

    const peeledInner = use(
      'use_tool',
      { agent_type: 'codex', task: 'introduce yourself' },
      'call-peeled'
    );
    expect(mergeHostDelegationView(peeledInner, null, null).agent_id).toBe(
      'codex'
    );
  });
});
