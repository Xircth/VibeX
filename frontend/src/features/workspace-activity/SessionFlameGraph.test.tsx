import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

describe('SessionFlameGraph', () => {
  it('renders turn waterfall cards with formatted durations, time ruler, and untimed indicators', () => {
    render(<SessionFlameGraph charts={charts} />);

    expect(screen.getByText('请全面排查并修复')).toBeInTheDocument();
    expect(screen.getByText('继续看后台任务')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();

    const bar = screen.getByTitle('排查 WebView 内存 · 2000ms');
    expect(bar.style.width).not.toBe('0%');

    expect(screen.getByText('1.25s')).toBeInTheDocument();
    expect(screen.getByText('2s')).toBeInTheDocument();
    expect(screen.getByText('--')).toBeInTheDocument();
  });
});
