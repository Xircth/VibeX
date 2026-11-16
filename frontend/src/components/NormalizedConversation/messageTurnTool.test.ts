import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
import { getToolSummary } from './conversation-entry-utils';
import { toolBlockToNormalizedEntry } from './messageTurnTool';

function use(tool_name: string, input: unknown, kind?: string): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: 't1',
    tool_name,
    kind: kind ?? null,
    input_preview: input === undefined ? null : JSON.stringify(input),
    meta: null,
  };
}

function result(output: string, isError = false): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 't1',
    output_preview: output,
    is_error: isError,
    agent_stats: null,
  };
}

describe('toolBlockToNormalizedEntry', () => {
  it('maps read to a file_read action', () => {
    const entry = toolBlockToNormalizedEntry(
      use('Read', { file_path: 'a.ts', offset: 80, limit: 40 }),
      result(
        JSON.stringify([
          {
            type: 'content',
            content: {
              type: 'text',
              text: '81: first line\n82: second line',
            },
          },
        ])
      ),
      null
    );
    expect(entry.entry_type).toMatchObject({
      type: 'tool_use',
      action_type: {
        action: 'file_read',
        path: 'a.ts',
        line_start: 81,
        line_end: 82,
        content: 'first line\nsecond line',
      },
      status: { status: 'success' },
    });
  });

  it('maps read_file target_file + FileContent to a file snippet', () => {
    const entry = toolBlockToNormalizedEntry(
      use('read_file', {
        variant: 'ReadFile',
        target_file: '/Users/mac/.agents/skills/understand/SKILL.md',
        offset: 1,
        limit: 40,
      }),
      result(
        JSON.stringify({
          type: 'ReadFile',
          FileContent: {
            content: '1→---\n2→name: understand\n3→description: Analyze',
          },
        })
      ),
      null
    );

    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'file_read',
        path: '/Users/mac/.agents/skills/understand/SKILL.md',
        line_start: 1,
        line_end: 3,
        content: '---\nname: understand\ndescription: Analyze',
      },
    });
    expect(entry.content).toBe('/Users/mac/.agents/skills/understand/SKILL.md');
  });

  it('does not repeat a generic tool name as its detail', () => {
    const entry = toolBlockToNormalizedEntry(
      use('mcp_custom', { a: 1 }),
      result('done'),
      null
    );
    expect(entry.content).toBe('');
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'tool', tool_name: 'mcp_custom' },
    });
  });

  it('maps bash to command_run with output', () => {
    const entry = toolBlockToNormalizedEntry(
      use('bash', { command: 'ls -la' }),
      result('file list'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'command_run',
        command: 'ls -la',
        result: { output: 'file list' },
      },
      status: { status: 'success' },
    });
  });

  it('maps spawn_subagent to a task_create action', () => {
    const entry = toolBlockToNormalizedEntry(
      use('spawn_subagent', {
        subagent_type: 'explore',
        description: 'Audit stream',
        prompt: 'look',
      }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'task_create',
        description: 'Audit stream',
        subagent_type: 'explore',
      },
    });
  });

  it('maps a placeholder tool named tool with variant ListDir to 查看目录', () => {
    void i18n.changeLanguage('zh-CN');
    const entry = toolBlockToNormalizedEntry(
      use('tool', {
        variant: 'ListDir',
        target_directory:
          'C:\\Users\\18190\\Documents\\projects\\dimo-plugin-computer-use\\src',
      }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'tool',
        tool_name: 'list_dir',
        arguments: {
          path: 'C:\\Users\\18190\\Documents\\projects\\dimo-plugin-computer-use\\src',
        },
      },
    });
    if (entry.entry_type.type !== 'tool_use') {
      throw new Error('expected a tool_use entry');
    }
    expect(getToolSummary(entry.entry_type, '').label).toBe('查看目录');
    expect(entry.entry_type.action_type).not.toMatchObject({
      tool_name: 'tool',
    });
  });

  it('maps other placeholder variants through the existing tool labels', () => {
    expect(
      toolBlockToNormalizedEntry(
        use('tool', { variant: 'ReadFile', target_file: 'a.ts' }),
        null,
        null
      ).entry_type
    ).toMatchObject({
      action_type: { action: 'file_read', path: 'a.ts' },
    });
    expect(
      toolBlockToNormalizedEntry(
        use('use_tool', { variant: 'Bash', command: 'ls' }),
        null,
        null
      ).entry_type
    ).toMatchObject({
      action_type: { action: 'command_run', command: 'ls' },
    });
    expect(
      toolBlockToNormalizedEntry(
        use('tool', { variant: 'Grep', pattern: 'foo' }),
        null,
        null
      ).entry_type
    ).toMatchObject({
      action_type: { action: 'search', query: 'foo' },
    });
    expect(
      toolBlockToNormalizedEntry(
        use('function', {
          variant: 'StrReplace',
          file_path: 'a.ts',
          old_string: 'a',
          new_string: 'b',
        }),
        null,
        null
      ).entry_type
    ).toMatchObject({
      action_type: { action: 'file_edit', path: 'a.ts' },
    });
    expect(
      toolBlockToNormalizedEntry(
        use('tool', { variant: 'Widgetize', count: 1 }),
        null,
        null
      ).entry_type
    ).toMatchObject({
      action_type: { action: 'tool', tool_name: 'Widgetize' },
    });
  });

  it('maps list_dir to a directory listing tool', () => {
    const entry = toolBlockToNormalizedEntry(
      use('list_dir', { target_directory: '/Users/mac/Projects/Dimo' }),
      result('src/\nREADME.md'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'tool',
        tool_name: 'list_dir',
        arguments: { path: '/Users/mac/Projects/Dimo' },
      },
    });
  });

  it('reads a nested web-search query instead of leaving the search blank', () => {
    const entry = toolBlockToNormalizedEntry(
      use('搜索', {
        action: {
          type: 'search',
          query: 'site:github.com dimo workflow creator plugin',
        },
      }),
      result(
        JSON.stringify({
          action: {
            type: 'search',
            query: 'site:github.com dimo workflow creator plugin',
            sources: [
              {
                type: 'url',
                url: 'https://github.com/jfmaes/awesome-ai-workflow',
              },
            ],
          },
        })
      ),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'search',
        query: 'site:github.com dimo workflow creator plugin',
      },
    });
  });

  it('maps grep to a search action', () => {
    const entry = toolBlockToNormalizedEntry(
      use('grep', { pattern: 'foo' }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'search', query: 'foo' },
    });
  });

  it('falls back to a generic tool action with parsed arguments + output', () => {
    const entry = toolBlockToNormalizedEntry(
      use('mcp_custom', { a: 1 }),
      result('done'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'tool',
        tool_name: 'mcp_custom',
        arguments: { a: 1 },
        result: { value: 'done' },
      },
    });
  });

  it('flags failed results', () => {
    const entry = toolBlockToNormalizedEntry(
      use('bash', { command: 'x' }),
      result('boom', true),
      null
    );
    expect(entry.entry_type).toMatchObject({ status: { status: 'failed' } });
  });

  it('infers a terminal card from an opaque call id with a command field', () => {
    const entry = toolBlockToNormalizedEntry(
      use('call_nxYPkqUD6iG01JU4bkloUcPP', { command: 'Get-ChildItem' }),
      result('ok'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'command_run', command: 'Get-ChildItem' },
    });
  });

  it('recognizes a PowerShell cmdlet tool title as a terminal', () => {
    const entry = toolBlockToNormalizedEntry(
      use('Get-ChildItem -Recurse -File', undefined),
      result('listing'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'command_run',
        command: 'Get-ChildItem -Recurse -File',
      },
    });
  });

  it('recognizes a flagged CLI command title as a terminal', () => {
    const entry = toolBlockToNormalizedEntry(
      use('git status --short', undefined),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'command_run', command: 'git status --short' },
    });
  });

  it('keeps a plain single-word tool name generic (not a terminal)', () => {
    const entry = toolBlockToNormalizedEntry(
      use('TodoWrite', { todos: [] }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'tool', tool_name: 'TodoWrite' },
    });
  });

  it('treats a bare-string tool input as a terminal command', () => {
    const entry = toolBlockToNormalizedEntry(
      use('exec', 'Get-ChildItem -Force'),
      result('listing'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'command_run', command: 'Get-ChildItem -Force' },
    });
  });

  it('joins an argv-array command (Codex shell calls)', () => {
    const entry = toolBlockToNormalizedEntry(
      use('local_shell', { command: ['bash', '-lc', 'echo hi'] }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'command_run', command: 'bash -lc echo hi' },
    });
  });

  it('gives an opaque call id a clean label when nothing can be inferred', () => {
    const entry = toolBlockToNormalizedEntry(
      use('call_IAoqgnGcy7OXY2fhczF8F5iV', { foo: 'bar' }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'tool', tool_name: '工具调用' },
    });
  });

  it('maps a structured edit to a file_edit diff card (not a read or a generic card)', () => {
    const entry = toolBlockToNormalizedEntry(
      use('call_abc123def456', {
        file_path: 'a.ts',
        old_string: 'x',
        new_string: 'y',
      }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'file_edit', path: 'a.ts' },
    });
    const action = entry.entry_type;
    if (
      action.type === 'tool_use' &&
      action.action_type.action === 'file_edit'
    ) {
      expect(action.action_type.changes[0]).toMatchObject({ action: 'edit' });
      expect(action.action_type.changes[0]).toHaveProperty('unified_diff');
    }
  });

  it('maps a Codex apply_patch envelope to a file_edit card with the patched path', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch';
    const entry = toolBlockToNormalizedEntry(
      use('apply_patch', { input: patch }),
      result('done'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'file_edit', path: 'src/app.ts' },
    });
  });

  it('maps a ready-made unified diff field to a file_edit card', () => {
    const entry = toolBlockToNormalizedEntry(
      use('Edit', { file_path: 'b.ts', diff: '@@ -1 +1 @@\n-a\n+b' }),
      null,
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'file_edit', path: 'b.ts' },
    });
  });

  it('keeps a path-only edit as an Edit file card instead of a generic title', () => {
    const entry = toolBlockToNormalizedEntry(
      use('Editing files', { path: 'src/App.tsx' }, 'edit'),
      null,
      null
    );

    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'file_edit',
        path: 'src/App.tsx',
        changes: [{ action: 'edit' }],
      },
    });
  });

  it('marks a completed command as a successful exit so the status dot is green', () => {
    const entry = toolBlockToNormalizedEntry(
      use('bash', { command: 'ls' }),
      result('files'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'command_run',
        result: { exit_status: { type: 'success', success: true } },
      },
    });
  });

  it('maps Codex fileChange single and multi-file changes to file_edit with unified diffs and fileEdits', () => {
    const entry = toolBlockToNormalizedEntry(
      use('fileChange', {
        changes: [
          {
            path: 'src/a.ts',
            kind: 'update',
            diff: '@@ -1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+export { a };',
          },
          {
            path: 'src/legacy.ts',
            kind: 'delete',
            diff: '@@ -1,2 +0,0 @@\n-old1\n-old2',
          },
        ],
      }),
      result('applied'),
      null
    );

    expect(entry.entry_type).toMatchObject({
      action_type: {
        action: 'file_edit',
        path: 'src/a.ts',
      },
    });
    expect(entry.fileEdits).toHaveLength(2);
    expect(entry.fileEdits?.[0]).toMatchObject({
      path: 'src/a.ts',
      changes: [
        {
          action: 'edit',
          has_line_numbers: true,
        },
      ],
    });
    const firstChange = entry.fileEdits?.[0]?.changes[0];
    if (firstChange?.action === 'edit') {
      expect(firstChange.unified_diff).toContain('+const a = 2;');
      expect(firstChange.unified_diff).toContain('+export { a };');
    }
    expect(entry.fileEdits?.[1]).toEqual({
      path: 'src/legacy.ts',
      changes: [{ action: 'delete' }],
    });
  });

  it('extracts aggregatedOutput for Codex commandExecution and suppresses empty JSON envelopes', () => {
    const withOutput = toolBlockToNormalizedEntry(
      use('commandExecution', { command: 'cargo test -p conversations' }),
      result(
        JSON.stringify({
          aggregatedOutput: 'test result: ok. 42 passed\n',
          exitCode: 0,
        })
      ),
      null
    );
    expect(withOutput.entry_type).toMatchObject({
      action_type: {
        action: 'command_run',
        command: 'cargo test -p conversations',
        result: {
          output: 'test result: ok. 42 passed\n',
          exit_status: { type: 'exit_code', code: 0 },
        },
      },
    });

    const silentEnvelope = toolBlockToNormalizedEntry(
      use('commandExecution', { command: 'mkdir -p dist' }),
      result(JSON.stringify({ aggregatedOutput: '', exitCode: 0 })),
      null
    );
    expect(silentEnvelope.entry_type).toMatchObject({
      action_type: {
        action: 'command_run',
        command: 'mkdir -p dist',
        result: {
          output: null,
          exit_status: { type: 'exit_code', code: 0 },
        },
      },
    });
  });

  it('unwraps Codex mcpToolCall envelopes for MCP metadata, ask_user_question, and delegation tools', () => {
    const mcpEntry = toolBlockToNormalizedEntry(
      use('mcpToolCall', {
        server: 'dimo-workflow-mcp',
        tool: 'run_step',
        arguments: { stepId: 'lint' },
      }),
      result(
        JSON.stringify({
          result: { content: [{ type: 'text', text: 'Step lint passed' }] },
        })
      ),
      null
    );
    expect(mcpEntry.toolMeta).toEqual({
      mcp: {
        server: 'dimo-workflow-mcp',
        tool: 'run_step',
      },
    });
    expect(mcpEntry.entry_type).toMatchObject({
      tool_name: 'run_step',
    });

    const askEntry = toolBlockToNormalizedEntry(
      use('mcpToolCall', {
        server: 'dimo-delegation-mcp',
        tool: 'ask_user_question',
        arguments: {
          questions: [
            {
              question: 'Which engine?',
              options: [{ label: 'Native' }, { label: 'ACP' }],
            },
          ],
        },
      }),
      null,
      null
    );
    expect(askEntry.entry_type).toMatchObject({
      tool_name: 'ask_user_question',
    });
    expect(askEntry.toolArguments).toMatchObject({
      questions: [{ question: 'Which engine?' }],
    });
  });

  it('maps Codex webSearch and collabAgentToolCall cleanly', () => {
    const searchEntry = toolBlockToNormalizedEntry(
      use('webSearch', {
        query: 'rust tokio mpsc channel',
        action: { queries: ['rust tokio mpsc channel'] },
      }),
      result('found 5 results'),
      null
    );
    expect(searchEntry.entry_type).toMatchObject({
      action_type: {
        action: 'search',
        query: 'rust tokio mpsc channel',
      },
    });

    const collabEntry = toolBlockToNormalizedEntry(
      use('collabAgentToolCall', {
        tool: 'spawnAgent',
        prompt: 'Audit timeline rendering',
      }),
      null,
      null
    );
    expect(collabEntry.entry_type).toMatchObject({
      action_type: {
        action: 'task_create',
        description: 'Audit timeline rendering',
      },
    });
  });
});
