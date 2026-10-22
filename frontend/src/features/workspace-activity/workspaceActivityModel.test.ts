import { describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  ExecutionProcess,
  JsonValue,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import {
  activityChartsFromTurns,
  collectWorkspaceActivityNotices,
  collectWorkspaceBackgroundTasks,
  formatDurationMs,
  spanWindow,
} from './workspaceActivityModel';

function text(value: string): ContentBlock {
  return { type: 'text', text: value };
}

function tool(
  id: string,
  name: string,
  input: Record<string, unknown> | null,
  startedAt?: string,
  endedAt?: string,
  meta?: JsonValue | null
): ContentBlock {
  return {
    type: 'tool_use',
    tool_use_id: id,
    tool_name: name,
    input_preview: input ? JSON.stringify(input) : null,
    started_at: startedAt ?? null,
    ended_at: endedAt ?? null,
    meta: meta ?? null,
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

describe('formatDurationMs', () => {
  it('formats milliseconds, seconds, and minutes cleanly', () => {
    expect(formatDurationMs(420)).toBe('420ms');
    expect(formatDurationMs(2_000)).toBe('2s');
    expect(formatDurationMs(1_250)).toBe('1.25s');
    expect(formatDurationMs(14_200)).toBe('14.2s');
    expect(formatDurationMs(72_000)).toBe('1m 12s');
  });
});

describe('collectWorkspaceBackgroundTasks', () => {
  it('collects ACP terminals, busy user terminals, live agent terminals, running delegations, and running processes', () => {
    const tasks = collectWorkspaceBackgroundTasks({
      terminalSessions: [
        {
          tabId: 'acp:term-1',
          sessionId: 'term-1',
          title: 'pnpm run dev',
          shellLabel: 'bash',
          cwd: '/repo',
          busy: true,
          source: 'acp',
          agentSessionId: 's1',
        },
        {
          tabId: 'user:term-2',
          sessionId: 'term-2',
          title: 'cargo watch',
          shellLabel: 'pwsh',
          cwd: '/repo',
          busy: true,
          source: 'workspace',
        },
        {
          tabId: 'user:term-idle',
          sessionId: 'term-idle',
          title: 'idle-shell',
          shellLabel: 'pwsh',
          cwd: '/repo',
          busy: false,
          source: 'workspace',
        },
      ],
      liveAgentTerminals: [
        {
          terminalId: 'term-1',
          agentSessionId: 's1',
          command: 'pnpm run dev',
          args: [],
          cwd: '/repo',
        },
        {
          terminalId: 'term-3',
          agentSessionId: 's1',
          command: 'npm',
          args: ['run', 'watch'],
          cwd: '/repo',
        },
      ],
      executionProcesses: [
        {
          id: 'proc-run',
          session_id: 's1',
          run_reason: 'devserver',
          status: 'running',
        } as unknown as ExecutionProcess,
        {
          id: 'proc-done',
          session_id: 's1',
          run_reason: 'setupscript',
          status: 'completed',
        } as unknown as ExecutionProcess,
      ],
      sessionTimelines: [
        {
          sessionId: 's1',
          sessionName: '会话一',
          turns: [
            turn('a-run', 'assistant', '2026-10-16T00:00:01.000Z', [
              tool(
                'del-1',
                'delegate_to_agent',
                { description: '子 Agent 排查样式' },
                '2026-10-16T00:00:02.000Z',
                undefined,
                { delegation: true }
              ),
            ]),
          ],
          rows: [],
        },
      ],
    });

    expect(tasks.map((task) => task.label)).toEqual([
      'pnpm run dev',
      'cargo watch',
      'npm run watch',
      '子 Agent 排查样式',
      '开发服务器',
    ]);
  });
});

describe('collectWorkspaceActivityNotices', () => {
  it('collects turn errors, session notices, failed tool results, and failed scripts across workspace sessions', () => {
    const rows: TimelineRow[] = [
      {
        row_id: 'notice-1',
        revision: 1n,
        row: {
          kind: 'session_notice',
          notice: {
            severity: 'warning',
            title: '上下文接近上限',
            message: '已自动压缩历史消息',
          },
        },
      },
      {
        row_id: 'err-1',
        revision: 2n,
        row: {
          kind: 'turn_error',
          error: {
            turn_id: 'a-err',
            error: {
              message: 'API 请求超时 (504)',
              code: 'GATEWAY_TIMEOUT',
              kind: 'service_error',
            },
          },
        },
      },
    ];

    const notices = collectWorkspaceActivityNotices({
      sessions: [
        { id: 's1', fullName: '会话一', isErrored: false },
        { id: 's2', fullName: '会话二', isErrored: true },
      ],
      sessionTimelines: [
        {
          sessionId: 's1',
          sessionName: '会话一',
          turns: [
            turn('a-tool-err', 'assistant', '2026-10-16T00:00:04.000Z', [
              tool('call-1', 'bash', { command: 'cargo check' }),
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                is_error: true,
                output_preview: 'error[E0425]: cannot find value `x`',
              },
            ]),
          ],
          rows,
        },
      ],
      executionProcesses: [
        {
          id: 'proc-fail',
          session_id: 's1',
          run_reason: 'setupscript',
          status: 'failed',
          exit_code: 1n,
        } as unknown as ExecutionProcess,
      ],
    });

    expect(notices.map((item) => item.message)).toContain('已自动压缩历史消息');
    expect(notices.map((item) => item.message)).toContain('API 请求超时 (504)');
    expect(
      notices.some((item) => item.message.includes('cannot find value'))
    ).toBe(true);
    expect(notices.some((item) => item.title.includes('初始化脚本'))).toBe(
      true
    );
    expect(notices.some((item) => item.sessionName === '会话二')).toBe(true);
  });
});
