import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageTurn } from 'shared/types';
import { SessionFlameGraph } from './SessionFlameGraph';
import type { ActivityChart } from './workspaceActivityModel';

const charts: ActivityChart[] = [
  {
    id: 'u1',
    divider: '请全面排查并修复',
    spans: [
      {
        id: 'assistant-1',
        label: '分析问题根因并准备修复',
        kind: 'assistant',
        startMs: 1_000,
        durationMs: 1_250,
        timed: true,
        children: [],
      },
      {
        id: 'tool-1',
        label: '排查 WebView 内存',
        kind: 'tool',
        startMs: 2_250,
        durationMs: 2_000,
        timed: true,
        children: [],
      },
      {
        id: 'tool-untimed',
        label: '未计时工具调用',
        kind: 'tool',
        startMs: 0,
        durationMs: 0,
        timed: false,
        children: [],
      },
    ],
  },
  {
    id: 'u2',
    divider: '继续看后台任务',
    spans: [
      {
        id: 'tool-2',
        label: '读取 App.tsx',
        kind: 'delegation',
        startMs: 4_000,
        durationMs: 1_000,
        timed: true,
        children: [],
      },
    ],
  },
];

const sampleTurns: MessageTurn[] = [
  {
    id: 'u1',
    role: 'user',
    timestamp: '2026-10-16T00:00:00.000Z',
    blocks: [{ type: 'text', text: '运行导航测试并检查输出' }],
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: '2026-10-16T00:00:01.000Z',
    completed_at: '2026-10-16T00:00:06.000Z',
    model: 'deepseek-chat',
    usage: {
      input_tokens: 1500n,
      output_tokens: 420n,
      cache_read_input_tokens: 1000n,
      cache_creation_input_tokens: 0n,
      context_used: 2000n,
      context_window_max: 64000n,
    },
    blocks: [
      { type: 'thinking', text: '先执行 echo 命令验证环境' },
      { type: 'text', text: '我来执行测试命令' },
      {
        type: 'tool_use',
        tool_use_id: 'call-1',
        tool_name: 'bash',
        input_preview: '{"command":"echo NAVIGATION_OK"}',
        started_at: '2026-10-16T00:00:02.000Z',
        ended_at: '2026-10-16T00:00:04.000Z',
      },
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        is_error: false,
        output_preview: 'NAVIGATION_OK',
      },
    ],
  },
];

describe('SessionFlameGraph (Trajectory View)', () => {
  it('renders toolbar, 3-lane timeline overview, and turn-aware event ledger from charts or turns', () => {
    render(<SessionFlameGraph charts={charts} />);

    expect(
      screen.getByRole('toolbar', { name: '轨迹工具栏' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: '轨迹时间线' })
    ).toBeInTheDocument();
    expect(screen.getByText('输入')).toBeInTheDocument();
    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getAllByText('工具').length).toBeGreaterThan(0);

    expect(screen.getByText('请全面排查并修复')).toBeInTheDocument();
    expect(screen.getByText('分析问题根因并准备修复')).toBeInTheDocument();
    expect(screen.getByText('排查 WebView 内存')).toBeInTheDocument();
    expect(screen.getByText('继续看后台任务')).toBeInTheDocument();
    expect(screen.getByText('1.25s')).toBeInTheDocument();
    expect(screen.getByText('2s')).toBeInTheDocument();
  });

  it('opens the Event Details inspector with Payload, Result, Usage, and Timing tabs when a ledger row is clicked', () => {
    render(<SessionFlameGraph turns={sampleTurns} />);

    expect(screen.getByText('NAVIGATION_OK')).toBeInTheDocument();

    const toolRow = screen
      .getByText('NAVIGATION_OK')
      .closest('tr') as HTMLElement;
    fireEvent.click(toolRow);

    const inspector = screen.getByRole('complementary', { name: '事件详情' });
    expect(inspector).toBeInTheDocument();
    expect(
      within(inspector).getByRole('tab', { name: '概述' })
    ).toBeInTheDocument();
    expect(
      within(inspector).getByRole('tab', { name: '参数' })
    ).toBeInTheDocument();
    expect(
      within(inspector).getByRole('tab', { name: '结果' })
    ).toBeInTheDocument();
    expect(
      within(inspector).getByRole('tab', { name: '计时' })
    ).toBeInTheDocument();

    fireEvent.click(within(inspector).getByRole('tab', { name: '结果' }));
    expect(within(inspector).getByText('NAVIGATION_OK')).toBeInTheDocument();

    const assistantRow = screen
      .getByText('我来执行测试命令')
      .closest('tr') as HTMLElement;
    fireEvent.click(assistantRow);

    expect(within(inspector).getByText('deepseek-chat')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole('tab', { name: '用量' }));
    expect(within(inspector).getByText('本次请求')).toBeInTheDocument();
    expect(within(inspector).getByText('会话累计')).toBeInTheDocument();
    expect(within(inspector).getAllByText('420 tok')).toHaveLength(2);
    expect(within(inspector).getAllByText('2000 / 64000 tok')).toHaveLength(2);
  });

  it('supports collapsing turns and calls and filtering via the search box', () => {
    render(<SessionFlameGraph charts={charts} />);

    const collapseCallsBtn = screen.getByRole('button', {
      name: '收起所有调用',
    });
    fireEvent.click(collapseCallsBtn);
    expect(screen.getByText(/2 个工具调用/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开所有调用' }));
    expect(screen.getByText('排查 WebView 内存')).toBeInTheDocument();

    const searchInput = screen.getByRole('searchbox', { name: '搜索轨迹' });
    fireEvent.change(searchInput, { target: { value: 'App.tsx' } });
    expect(screen.getByText('读取 App.tsx')).toBeInTheDocument();
    expect(screen.queryByText('排查 WebView 内存')).not.toBeInTheDocument();
  });
});
