import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from './messageTurnBlocks';
import { groupTurnRenderItems } from './messageTurnAggregate';

function toolItem(toolName: string, input: unknown) {
  const use: ToolUseBlock = {
    type: 'tool_use',
    tool_use_id: `id-${toolName}-${JSON.stringify(input)}`,
    tool_name: toolName,
    input_preview: JSON.stringify(input),
    meta: null,
  };
  return { kind: 'tool' as const, use, result: null };
}

describe('groupTurnRenderItems', () => {
  it('folds a run of consecutive commands into one tool group', () => {
    const units = groupTurnRenderItems([
      toolItem('bash', { command: 'one' }),
      toolItem('bash', { command: 'two' }),
      toolItem('bash', { command: 'three' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
    if (units[0].kind === 'tool_group') {
      expect(units[0].items).toHaveLength(3);
      expect(units[0].items.map((entry) => entry.index)).toEqual([0, 1, 2]);
    }
  });

  it('keeps a lone command inside an expandable tool group', () => {
    const units = groupTurnRenderItems([toolItem('bash', { command: 'solo' })]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
    if (units[0].kind === 'tool_group') {
      expect(units[0].items).toHaveLength(1);
    }
  });

  it('breaks a run when a non-tool item interrupts it', () => {
    const units = groupTurnRenderItems([
      toolItem('bash', { command: 'a' }),
      { kind: 'markdown', text: 'note' },
      toolItem('bash', { command: 'b' }),
    ]);
    expect(units.map((unit) => unit.kind)).toEqual([
      'tool_group',
      'single',
      'tool_group',
    ]);
  });

  it('merges different tool kinds when they are consecutive', () => {
    const units = groupTurnRenderItems([
      toolItem('bash', { command: 'a' }),
      toolItem('Read', { file_path: 'x.ts' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
    if (units[0].kind === 'tool_group') {
      expect(units[0].items).toHaveLength(2);
    }
  });

  it('groups consecutive reads of the same tool', () => {
    const units = groupTurnRenderItems([
      toolItem('Read', { file_path: 'a.ts' }),
      toolItem('Read', { file_path: 'b.ts' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
  });

  it('folds consecutive generic tool calls into a 工具调用 group', () => {
    const units = groupTurnRenderItems([
      toolItem('call_aaa111bbb', { foo: 1 }),
      toolItem('call_ccc222ddd', { bar: 2 }),
      toolItem('call_eee333fff', { baz: 3 }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
  });

  it('merges generic tools with terminal commands in the same run', () => {
    const units = groupTurnRenderItems([
      toolItem('call_aaa111bbb', { foo: 1 }),
      toolItem('bash', { command: 'ls' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
  });

  it('aggregates file edits while preserving each diff as row detail', () => {
    const units = groupTurnRenderItems([
      toolItem('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      toolItem('Edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'tool_group' });
  });
});
