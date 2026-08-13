import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
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
        line_end: 120,
        content: '81: first line\n82: second line',
      },
      status: { status: 'success' },
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
});
