import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEntryType } from 'shared/types';
import type { PatchTypeWithKey } from '@/hooks/conversationEntries';
import { LiveTurnStats } from './LiveTurnStats';
import { formatCompletionTime, TurnStats } from './TurnStats';
import { buildTurnStatsByAssistantKey, turnTokenTotal } from './turnStatsModel';

function normalizedEntry(
  patchKey: string,
  entryType: NormalizedEntryType,
  content: string,
  timestamp: string | null
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey,
    executionProcessId: 'process-1',
    content: {
      entry_type: entryType,
      content,
      timestamp,
    },
  };
}

describe('TurnStats', () => {
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    clipboardWrite.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders available turn metadata and actions while hiding missing fields', async () => {
    const onJumpBack = vi.fn();

    render(
      <TurnStats
        copyText="assistant answer"
        onJumpBack={onJumpBack}
        stats={{
          model: 'gpt-5-codex',
          totalTokens: 12345,
          contextWindow: 100000,
          cacheReadTokens: 300,
          cacheWriteTokens: 45,
          elapsedMs: 65000,
          completedAt: '2026-03-22T12:34:00.000Z',
        }}
      />
    );

    expect(screen.queryByText('模型')).not.toBeInTheDocument();
    expect(screen.queryByText('gpt-5-codex')).not.toBeInTheDocument();
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.queryByText(/100,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12,345 \/ /)).not.toBeInTheDocument();
    expect(screen.queryByText('耗时')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存读')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存写')).not.toBeInTheDocument();
    expect(screen.queryByText('300')).not.toBeInTheDocument();
    expect(screen.queryByText('45')).not.toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '从此处分叉' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('完成')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '耗时 1m 5s' }));
    expect(
      screen.getByText(formatCompletionTime('2026-03-22T12:34:00.000Z') ?? '')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制回复' }));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith('assistant answer')
    );

    fireEvent.click(screen.getByRole('button', { name: '回到上一条用户消息' }));
    expect(onJumpBack).toHaveBeenCalledTimes(1);
  });

  it('places fork next to copy and keeps it readable when disabled', () => {
    const onForkFromHere = vi.fn();
    const { rerender } = render(
      <TurnStats copyText="assistant answer" onForkFromHere={onForkFromHere} />
    );
    fireEvent.click(screen.getByRole('button', { name: '从此处分叉' }));
    expect(onForkFromHere).toHaveBeenCalledTimes(1);
    rerender(
      <TurnStats
        copyText="assistant answer"
        onForkFromHere={onForkFromHere}
        forkDisabled
      />
    );
    expect(screen.getByRole('button', { name: '从此处分叉' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('button', { name: '从此处分叉' })).toHaveAttribute(
      'title',
      '请等当前回合结束后再分叉'
    );
    rerender(
      <TurnStats
        copyText="assistant answer"
        onForkFromHere={onForkFromHere}
        forkDisabled
        forkDisabledReason="unnamed"
      />
    );
    expect(screen.getByRole('button', { name: '从此处分叉' })).toHaveAttribute(
      'title',
      '这条回复还不能作为分叉点'
    );
  });

  it('shows only consumed tokens, not the context-window ratio', () => {
    render(
      <TurnStats
        stats={{
          totalTokens: 18658,
          contextWindow: 258400,
          elapsedMs: 1000,
        }}
      />
    );

    expect(screen.getByText('18,658')).toBeInTheDocument();
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.queryByText(/258,400/)).not.toBeInTheDocument();
    expect(screen.queryByText('18,658 / 258,400')).not.toBeInTheDocument();
  });

  it('hides a zero token total instead of painting it as a fact', () => {
    render(<TurnStats stats={{ totalTokens: 0, elapsedMs: 1000 }} />);
    expect(screen.queryByText('Token')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('1s')).toBeInTheDocument();
  });

  it('does not render an empty stats row', () => {
    const { container } = render(<TurnStats stats={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('updates live elapsed time from the turn start timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:05.000Z'));

    render(
      <LiveTurnStats
        startedAt="2026-03-22T00:00:00.000Z"
        copyText="streaming answer"
      />
    );

    expect(screen.getByText('生成中')).toBeInTheDocument();
    expect(screen.getByText('状态')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();

    vi.setSystemTime(new Date('2026-03-22T00:00:07.000Z'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('8s')).toBeInTheDocument();
  });
});

describe('turnTokenTotal', () => {
  it('prefers spend totals and falls back to occupancy without inventing zero', () => {
    expect(
      turnTokenTotal({
        input_tokens: 40000n,
        output_tokens: 300n,
        cache_creation_input_tokens: 0n,
        cache_read_input_tokens: 2000n,
        context_used: 18658n,
      })
    ).toBe(42300);
    expect(
      turnTokenTotal({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_used: 18658,
      })
    ).toBe(18658);
    expect(
      turnTokenTotal({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_used: 0,
      })
    ).toBeNull();
  });
});

describe('buildTurnStatsByAssistantKey', () => {
  it('attaches usage and elapsed metadata to the assistant turn', () => {
    const stats = buildTurnStatsByAssistantKey(
      [
        normalizedEntry(
          'user-1',
          { type: 'user_message' },
          'please help',
          '2026-03-22T00:00:00.000Z'
        ),
        normalizedEntry(
          'assistant-1',
          { type: 'assistant_message' },
          'done',
          '2026-03-22T00:00:03.000Z'
        ),
        normalizedEntry(
          'usage-1',
          {
            type: 'token_usage_info',
            total_tokens: 1200,
            model_context_window: 64000,
          },
          '',
          '2026-03-22T00:00:04.000Z'
        ),
      ],
      {
        modelByExecutionProcessId: {
          'process-1': 'gpt-5-codex',
        },
      }
    );

    expect(stats.get('assistant-1')).toMatchObject({
      model: 'gpt-5-codex',
      startedAt: '2026-03-22T00:00:00.000Z',
      totalTokens: 1200,
      contextWindow: 64000,
      elapsedMs: 4000,
      completedAt: '2026-03-22T00:00:04.000Z',
    });
  });
});
