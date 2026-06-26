import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThinkingEntry } from './ThinkingEntry';

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
