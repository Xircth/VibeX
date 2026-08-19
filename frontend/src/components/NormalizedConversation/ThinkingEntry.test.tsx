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

    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.getByText('checking the plan')).toBeInTheDocument();
    expect(screen.queryByText('1m 5s')).not.toBeInTheDocument();

    rerender(
      <ThinkingEntry
        content="checking the plan"
        expansionKey="stream-auto-collapse"
        isStreaming={false}
        elapsedMs={65000}
      />
    );

    expect(screen.queryByText('checking the plan')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '展开思考' })
    ).toBeInTheDocument();
  });

  it('keeps a user-expanded finished thought open across content updates', () => {
    const { rerender } = render(
      <ThinkingEntry
        content="first finished thought"
        expansionKey="manual-open"
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
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
