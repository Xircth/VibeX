import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  applySubagentLifecycle,
  buildSubagentCardModel,
  collectSubagentLifecycleIndex,
  foldSubagentLifecycle,
  formatSubagentDuration,
  formatTokenCount,
  isHostDelegationLifecycleTool,
  isHostDelegationTool,
  isNativeSubagentTool,
  shouldHideLifecycleTool,
} from './subagentCardModel';

function use(
  toolName: string,
  input: unknown,
  meta: unknown = null
): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: 'call-1',
    tool_name: toolName,
    kind: null,
    input_preview: input == null ? null : JSON.stringify(input),
    meta: meta as ToolUseBlock['meta'],
  };
}

function result(
  output: string | null,
  isError = false,
  agentStats: ToolResultBlock['agent_stats'] = null
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'call-1',
    output_preview: output,
    is_error: isError,
    agent_stats: agentStats,
  };
}

describe('subagent card model', () => {
  it('recognizes Grok spawn_subagent and Claude Task payloads', () => {
    expect(
      isNativeSubagentTool(
        use('spawn_subagent', {
          subagent_type: 'explore',
          description: 'Audit stream',
        })
      )
    ).toBe(true);
    expect(
      isNativeSubagentTool(
        use('Task', {
          subagent_type: 'general-purpose',
          prompt: 'Review the diff',
        })
      )
    ).toBe(true);
    expect(isNativeSubagentTool(use('bash', { command: 'ls' }))).toBe(false);
    expect(
      isNativeSubagentTool(use('Task', { title: 'Write the weekly report' }))
    ).toBe(false);
    expect(
      isNativeSubagentTool(
        use('delegate_to_agent', { agent_type: 'grok', task: 'look' })
      )
    ).toBe(false);
    expect(
      isHostDelegationTool(
        use('delegate_to_agent', { agent_type: 'grok', task: 'look' })
      )
    ).toBe(true);
    expect(
      isHostDelegationLifecycleTool(
        use('get_delegation_status', { task_ids: ['task-1'] })
      )
    ).toBe(true);
  });

  it('builds a live running card from progress metadata', () => {
    const model = buildSubagentCardModel(
      use(
        'spawn_subagent',
        {
          subagent_type: 'explore',
          description: 'Audit agent message stream',
          prompt: 'Inspect the parent transcript',
        },
        {
          subagent: {
            status: 'background',
            progress: {
              toolCallCount: 125,
              turnCount: 1,
              durationMs: 5400,
              contextUsagePct: 32,
            },
          },
        }
      ),
      result('Subagent started in background.\nsubagent_id: sub-1')
    );

    expect(model.title).toBe('explore: Audit agent message stream');
    expect(model.prompt).toBe('Inspect the parent transcript');
    expect(model.status).toBe('background');
    expect(model.toolCallCount).toBe(125);
    expect(model.turnCount).toBe(1);
    expect(model.durationMs).toBe(5400);
    expect(model.contextUsagePct).toBe(32);
    expect(model.resultText).toBeNull();
  });

  it('surfaces tokens from a finished child', () => {
    const model = buildSubagentCardModel(
      use(
        'Agent',
        { subagent_type: 'explore', description: 'Audit' },
        {
          subagent: {
            status: 'completed',
            progress: { tokenCount: 18432, toolCallCount: 125 },
          },
        }
      ),
      result('done')
    );
    expect(model.status).toBe('completed');
    expect(model.tokenCount).toBe(18432);
    expect(formatTokenCount(18432)).toBe('18k');
    expect(formatSubagentDuration(5400)).toBe('5.4s');
  });

  it('folds wait_agent and close_agent onto the matching spawn card', () => {
    const spawn = use(
      'spawn_agent',
      { agent_type: 'worker', description: 'Review the diff', prompt: 'look' },
      null
    );
    spawn.tool_use_id = 'spawn-1';
    const wait = use('wait_agent', { agent_id: 'agent-7' });
    wait.tool_use_id = 'wait-1';
    const close = use('close_agent', { agent_id: 'agent-7' });
    close.tool_use_id = 'close-1';
    const spawnResult = result('{"agent_id":"agent-7"}');
    spawnResult.tool_use_id = 'spawn-1';
    const waitResult = result('Review finished. No issues found.');
    waitResult.tool_use_id = 'wait-1';
    const closeResult = result('closed');
    closeResult.tool_use_id = 'close-1';

    const folded = foldSubagentLifecycle([
      { use: spawn, result: spawnResult },
      { use: wait, result: waitResult },
      { use: close, result: closeResult },
    ]);

    expect(folded.cards).toHaveLength(1);
    expect(folded.hiddenToolUseIds).toEqual(new Set(['wait-1', 'close-1']));
    const model = applySubagentLifecycle(
      buildSubagentCardModel(spawn, spawnResult),
      folded.cards[0].lifecycle
    );
    expect(model.status).toBe('completed');
    expect(model.resultText).toBe('Review finished. No issues found.');
  });

  it('keeps an in-flight wait as running instead of treating spawn as done', () => {
    const spawn = use('spawn_agent', {
      agent_id: 'agent-7',
      agent_type: 'worker',
      description: 'Review',
    });
    const wait = use('wait_agent', { agent_id: 'agent-7' });
    wait.tool_use_id = 'wait-1';
    const folded = foldSubagentLifecycle([
      { use: spawn, result: result('started') },
      { use: wait, result: null },
    ]);
    const model = applySubagentLifecycle(
      buildSubagentCardModel(spawn, result('started')),
      folded.cards[0].lifecycle
    );
    expect(model.status).toBe('running');
    expect(model.resultText).toBeNull();
    expect(folded.hiddenToolUseIds.has('wait-1')).toBe(true);
  });

  it('does not hide a wait that belongs to another agent', () => {
    const spawn = use('spawn_agent', { agent_id: 'agent-7', description: 'A' });
    const wait = use('wait_agent', { agent_id: 'agent-8' });
    wait.tool_use_id = 'wait-8';
    const folded = foldSubagentLifecycle([
      { use: spawn, result: null },
      { use: wait, result: null },
    ]);
    expect(folded.hiddenToolUseIds.has('wait-8')).toBe(false);
    expect(folded.cards[0].lifecycle).toEqual([]);
  });

  it('hides a later wait that targets a known spawn binding', () => {
    const spawn = use('spawn_agent', { agent_id: 'agent-7', description: 'A' });
    const wait = use('wait_agent', { agent_id: 'agent-7' });
    const index = collectSubagentLifecycleIndex([
      { use: spawn, result: result('started') },
      { use: wait, result: result('done') },
    ]);
    expect(index.spawnBindingIds.has('agent-7')).toBe(true);
    expect(
      shouldHideLifecycleTool(wait, result('done'), index.spawnBindingIds)
    ).toBe(true);
  });

  it('does not fold host MCP delegation onto a native subagent card', () => {
    const spawn = use('delegate_to_agent', {
      agent_type: 'grok',
      task: 'Review the diff',
    });
    spawn.tool_use_id = 'spawn-1';
    const poll = use('get_delegation_status', { task_ids: ['task-1'] });
    poll.tool_use_id = 'poll-1';
    const folded = foldSubagentLifecycle([
      { use: spawn, result: result('{"task_id":"task-1","status":"running"}') },
      { use: poll, result: null },
    ]);

    expect(folded.cards).toHaveLength(0);
    expect(isHostDelegationTool(spawn)).toBe(true);
    expect(isHostDelegationLifecycleTool(poll)).toBe(true);
  });

  it('folds Grok poll output onto the spawn card with stats and completed status', () => {
    const spawn = use('spawn_subagent', {
      subagent_type: 'explore',
      description: 'Audit stream',
      prompt: 'Inspect the parent transcript',
      background: true,
    });
    spawn.tool_use_id = 'spawn-1';
    const poll = use('get_command_or_subagent_output', {
      task_id: 'sub-1',
    });
    poll.tool_use_id = 'poll-1';
    const spawnResult = result(
      'Subagent started in background.\nsubagent_id: sub-1'
    );
    spawnResult.tool_use_id = 'spawn-1';
    const pollResult = result(
      JSON.stringify({
        status: 'completed',
        result: 'Audit finished.',
        tool_call_count: 125,
        context_usage_pct: 32,
        tokens_used: 18432,
      })
    );
    pollResult.tool_use_id = 'poll-1';

    const folded = foldSubagentLifecycle([
      { use: spawn, result: spawnResult },
      { use: poll, result: pollResult },
    ]);

    expect(folded.cards).toHaveLength(1);
    expect(folded.hiddenToolUseIds).toEqual(new Set(['poll-1']));
    const model = applySubagentLifecycle(
      buildSubagentCardModel(spawn, spawnResult),
      folded.cards[0].lifecycle
    );
    expect(model.status).toBe('completed');
    expect(model.toolCallCount).toBe(125);
    expect(model.contextUsagePct).toBe(32);
    expect(model.tokenCount).toBe(18432);
    expect(model.resultText).toBe('Audit finished.');
    expect(model.agentKind).toBe('grok');
  });

  it('unwraps TaskOutput JSON into the child markdown, not the envelope', () => {
    const model = buildSubagentCardModel(
      use('Task', {
        subagent_type: 'general-purpose',
        description: 'Search GitHub similar projects',
        prompt: 'Find **similar** projects.',
      }),
      result(
        JSON.stringify({
          type: 'TaskOutput',
          Result: {
            task_id: '01a0101b-7d9c-7563-b45d-be897f16a766',
            command:
              '[subagent:general-purpose] Search GitHub similar projects',
            status: 'completed',
            exit_code: 0,
            started: '2026-08-17T14:23:52Z',
            ended: '2026-08-17T14:28:52Z',
            duration_secs: 12,
            output:
              '# Similar-project search\n\nThere are **none** for this plugin.',
          },
        })
      )
    );

    expect(model.status).toBe('completed');
    expect(model.resultText).toBe(
      '# Similar-project search\n\nThere are **none** for this plugin.'
    );
    expect(model.resultText).not.toContain('TaskOutput');
    expect(model.resultText).not.toContain('task_id');
    expect(model.durationMs).toBe(5 * 60 * 1000);
  });

  it('resolves the delegated agent kind for Grok spawn and host delegation', () => {
    expect(
      buildSubagentCardModel(
        use('spawn_subagent', { subagent_type: 'explore', prompt: 'look' }),
        null
      ).agentKind
    ).toBe('grok');
    expect(
      buildSubagentCardModel(
        use('delegate_to_agent', { agent_type: 'grok', task: 'look' }),
        null
      ).agentKind
    ).toBe('grok');
    expect(
      buildSubagentCardModel(
        use('Task', { subagent_type: 'explore', prompt: 'look' }),
        null,
        'claude_code'
      ).agentKind
    ).toBe('claude_code');
  });
});
