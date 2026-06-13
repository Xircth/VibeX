import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import { AggregatedThinkingCard } from './AggregatedThinkingCard';
import { ThinkingEntry } from './ThinkingEntry';

function thinkingEntry(
  key: string,
  content: string,
  timestamp: string
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: key,
    executionProcessId: 'thinking-test',
    content: {
      entry_type: { type: 'thinking' },
      content,
      timestamp,
    },
  };
}

describe('ThinkingEntry', () => {
  it('streams expanded and auto-collapses when the turn finishes', () => {
    const { rerender } = render(
      <ThinkingEntry
        content="checking the plan"
        expansionKey="stream-auto-collapse"
        isStreaming
        elapsedMs={65000}
      />
    );

    expect(screen.getByText('checking the plan')).toBeInTheDocument();
    expect(screen.getByText('思考中')).toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();

    rerender(
      <ThinkingEntry
        content="checking the plan"
        expansionKey="stream-auto-collapse"
        isStreaming={false}
        elapsedMs={65000}
      />
    );

    expect(screen.queryByText('checking the plan')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('keeps a user-expanded finished thought open across content updates', () => {
    const { rerender } = render(
      <ThinkingEntry
        content="first finished thought"
        expansionKey="manual-open"
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand Thinking' }));
    expect(screen.getByText('first finished thought')).toBeInTheDocument();

    rerender(
      <ThinkingEntry
        content="updated finished thought"
        expansionKey="manual-open"
        isStreaming={false}
      />
    );

    expect(screen.getByText('updated finished thought')).toBeInTheDocument();
  });
});

describe('AggregatedThinkingCard', () => {
  it('shows count, elapsed time, and merged thinking content', () => {
    render(
      <AggregatedThinkingCard
        expansionKey="aggregate"
        entries={[
          thinkingEntry(
            'think-1',
            'first hidden thought',
            '2026-06-13T08:00:00.000Z'
          ),
          thinkingEntry(
            'think-2',
            'second hidden thought',
            '2026-06-13T08:01:05.000Z'
          ),
        ]}
      />
    );

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Thinking' }));

    expect(screen.getByText('first hidden thought')).toBeInTheDocument();
    expect(screen.getByText('second hidden thought')).toBeInTheDocument();
  });

  it('opens and shows streaming status for live aggregated thinking', () => {
    render(
      <AggregatedThinkingCard
        expansionKey="aggregate-live"
        isStreaming
        entries={[
          thinkingEntry(
            'think-live',
            'live hidden thought',
            new Date().toISOString()
          ),
        ]}
      />
    );

    expect(screen.getByText('思考中')).toBeInTheDocument();
    expect(screen.getByText('live hidden thought')).toBeInTheDocument();
  });
});
