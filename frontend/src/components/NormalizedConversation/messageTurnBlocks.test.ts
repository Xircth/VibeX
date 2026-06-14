import { describe, expect, it } from 'vitest';
import type { ContentBlock } from 'shared/types';
import { planTurnBlocks } from './messageTurnBlocks';

describe('planTurnBlocks', () => {
  it('passes text, thinking and image blocks through in order', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAAA', mime_type: 'image/png', uri: null },
    ];
    expect(planTurnBlocks(blocks)).toEqual([
      { kind: 'thinking', text: 'hmm' },
      { kind: 'markdown', text: 'hello' },
      { kind: 'image', data: 'AAAA', mimeType: 'image/png', uri: null },
    ]);
  });

  it('pairs a tool_use with its matching tool_result', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', tool_use_id: 't1', tool_name: 'read', input_preview: 'a.ts', meta: null },
      { type: 'tool_result', tool_use_id: 't1', output_preview: 'ok', is_error: false, agent_stats: null },
    ];
    const items = planTurnBlocks(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      use: { tool_name: 'read' },
      result: { output_preview: 'ok', is_error: false },
    });
  });

  it('keeps a tool_use with no result yet', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', tool_use_id: 't1', tool_name: 'read', input_preview: null, meta: null },
    ];
    expect(planTurnBlocks(blocks)).toEqual([
      {
        kind: 'tool',
        use: { type: 'tool_use', tool_use_id: 't1', tool_name: 'read', input_preview: null, meta: null },
        result: null,
      },
    ]);
  });

  it('passes a plan block through as a plan item', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'plan',
        entries: [{ content: 'Step 1', status: 'completed', priority: null }],
      },
    ];
    expect(planTurnBlocks(blocks)).toEqual([
      {
        kind: 'plan',
        entries: [{ content: 'Step 1', status: 'completed', priority: null }],
      },
    ]);
  });

  it('renders an orphan tool_result standalone', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'orphan', output_preview: 'late', is_error: true, agent_stats: null },
    ];
    const items = planTurnBlocks(blocks);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', use: null, result: { is_error: true } });
  });
});
