import { describe, expect, it } from 'vitest';
import type { ContentBlock, MessageTurn } from 'shared/types';
import { activityChartsFromTurns, spanWindow } from './workspaceActivityModel';

function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

function tool(
  id: string,
  name: string,
  input: Record<string, unknown> | null,
  startedAt?: string,
  endedAt?: string
): ContentBlock {
  return {
    type: 'tool_use',
    tool_use_id: id,
    tool_name: name,
    input_preview: input ? JSON.stringify(input) : null,
    started_at: startedAt ?? null,
    ended_at: endedAt ?? null,
  };
}

function turn(
  id: string,
  role: MessageTurn['role'],
  timestamp: string,
  blocks: ContentBlock[],
  completedAt?: string
): MessageTurn {
  return {
    id,
    role,
    timestamp,
    blocks,
    completed_at: completedAt ?? null,
  };
}

describe('activityChartsFromTurns', () => {
  const turns = [
    turn('u1', 'user', '2026-10-16T00:00:00.000Z', [text('请全面排查并修复')]),
    turn(
      'a1',
      'assistant',
      '2026-10-16T00:00:01.000Z',
      [
        text('已启动后端投影单测'),
        tool(
          'call_426432',
          'call_426432',
          { description: '排查 WebView 内存', path: 'src/App.tsx' },
          '2026-10-16T00:00:02.000Z',
          '2026-10-16T00:00:04.000Z'
        ),
        tool(
          'call_426439',
          'call_426439',
          { command: 'pnpm test' },
          '2026-10-16T00:00:04.000Z',
          '2026-10-16T00:00:09.000Z'
        ),
        tool(
          '4d92f100-1b53-4e18-ad49-16851688543e:3',
          '4d92f100-1b53-4e18-ad49-16851688543e:3',
          null
        ),
      ],
      '2026-10-16T00:00:11.000Z'
    ),
    turn('u2', 'user', '2026-10-16T00:01:00.000Z', [text('继续看后台任务')]),
    turn('a2', 'assistant', '2026-10-16T00:01:01.000Z', [
      tool(
        'call_509490',
        'read_file',
        { path: 'frontend/src/App.tsx' },
        '2026-10-16T00:01:02.000Z',
        '2026-10-16T00:01:03.000Z'
      ),
    ]),
  ];

  function charts() {
    return activityChartsFromTurns(turns);
  }

  it('keeps assistant text and each tool as flat rows on that chart', () => {
    const spans = charts()[0]?.spans ?? [];
    expect(spans.map((span) => span.kind)).toEqual([
      'assistant',
      'tool',
      'tool',
      'tool',
    ]);
    expect(spans[0]?.label).toBe('已启动后端投影单测');
    expect(spans.every((span) => span.children.length === 0)).toBe(true);
  });

  it('opens a separate chart for each user message', () => {
    expect(charts().map((chart) => chart.divider)).toEqual([
      '请全面排查并修复',
      '继续看后台任务',
    ]);
    expect(
      charts()[0]?.spans.some((span) => span.label.includes('App.tsx'))
    ).toBe(false);
    expect(
      charts()[1]
        ?.spans.map((span) => span.label)
        .join(' ')
    ).toContain('App.tsx');
  });

  it('labels events with the conversation description instead of an id', () => {
    const labels = charts()[0]?.spans.map((span) => span.label) ?? [];
    expect(labels).toContain('排查 WebView 内存');
    expect(labels.join(' ')).not.toMatch(/call_\d+/);
    expect(labels.join(' ')).not.toMatch(
      /4d92f100-1b53-4e18-ad49-16851688543e/
    );
    expect(labels).toContain('工具调用');
  });

  it('uses stored tool windows and does not split the turn evenly', () => {
    const timed = charts()[0]?.spans.filter((span) => span.timed) ?? [];
    const memory = timed.find((span) => span.label === '排查 WebView 内存');
    const tests = timed.find((span) => span.label.includes('pnpm test'));
    expect(memory?.durationMs).toBe(2_000);
    expect(tests?.durationMs).toBe(5_000);
    expect(memory?.durationMs).not.toBe(tests?.durationMs);

    const untitled = charts()[0]?.spans.find(
      (span) => span.label === '工具调用'
    );
    expect(untitled?.timed).toBe(false);
    expect(untitled?.durationMs).toBe(0);
    expect(spanWindow(charts()[0]?.spans ?? []).endMs).toBe(
      Date.parse('2026-10-16T00:00:11.000Z')
    );
  });
});
