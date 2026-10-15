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
        id: 'tool-1',
        label: '排查 WebView 内存',
        kind: 'tool',
        startMs: 1_000,
        durationMs: 2_000,
        timed: true,
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
        kind: 'tool',
        startMs: 4_000,
        durationMs: 1_000,
        timed: true,
        children: [],
      },
    ],
  },
];

describe('SessionFlameGraph', () => {
  it('draws one square gantt per user message', () => {
    render(<SessionFlameGraph charts={charts} />);

    expect(screen.getByText('请全面排查并修复')).toBeInTheDocument();
    expect(screen.getByText('继续看后台任务')).toBeInTheDocument();
    const bar = screen.getByTitle('排查 WebView 内存 · 2000ms');
    expect(bar.className).not.toMatch(/rounded/);
    expect(bar.style.width).not.toBe('0%');
    expect(bar.style.borderRadius).toBe('');
  });
});
