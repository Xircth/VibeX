import { describe, expect, it } from 'vitest';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
import { toolBlockToNormalizedEntry } from './messageTurnTool';

function use(tool_name: string, input: unknown): ToolUseBlock {
  return {
    type: 'tool_use',
    tool_use_id: 't1',
    tool_name,
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
    const entry = toolBlockToNormalizedEntry(use('Read', { file_path: 'a.ts' }), null, null);
    expect(entry.entry_type).toMatchObject({
      type: 'tool_use',
      action_type: { action: 'file_read', path: 'a.ts' },
      status: { status: 'created' },
    });
  });

  it('maps bash to command_run with output', () => {
    const entry = toolBlockToNormalizedEntry(
      use('bash', { command: 'ls -la' }),
      result('file list'),
      null
    );
    expect(entry.entry_type).toMatchObject({
      action_type: { action: 'command_run', command: 'ls -la', result: { output: 'file list' } },
      status: { status: 'success' },
    });
  });

  it('maps grep to a search action', () => {
    const entry = toolBlockToNormalizedEntry(use('grep', { pattern: 'foo' }), null, null);
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
    const entry = toolBlockToNormalizedEntry(use('bash', { command: 'x' }), result('boom', true), null);
    expect(entry.entry_type).toMatchObject({ status: { status: 'failed' } });
  });
});
