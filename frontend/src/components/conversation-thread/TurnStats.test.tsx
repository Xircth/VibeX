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
import { buildTurnStatsByAssistantKey } from './turnStatsModel';

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

    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getByText('gpt-5-codex')).toBeInTheDocument();
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.queryByText(/100,000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12,345 \/ /)).not.toBeInTheDocument();
    expect(screen.queryByText('Token')).not.toBeInTheDocument();
    expect(screen.queryByText('耗时')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存读')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存写')).not.toBeInTheDocument();
    expect(screen.queryByText('300')).not.toBeInTheDocument();
    expect(screen.queryByText('45')).not.toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
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
    expect(screen.queryByText(/258,400/)).not.toBeInTheDocument();
    expect(screen.queryByText('18,658 / 258,400')).not.toBeInTheDocument();
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
    expect(screen.getByText('5s')).toBeInTheDocument();

    vi.setSystemTime(new Date('2026-03-22T00:00:07.000Z'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('8s')).toBeInTheDocument();
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
