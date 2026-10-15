import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThinkingEntry } from './ThinkingEntry';

const convToolsStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-tools.css'),
  'utf8'
);

describe('ThinkingEntry', () => {
  it('streams expanded and auto-collapses when the turn finishes', async () => {
    const { rerender } = render(
      <ThinkingEntry
        content="checking the plan"
        expansionKey="stream-auto-collapse"
        isStreaming
        elapsedMs={65000}
      />
    );

    expect(screen.getByText('思考')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '收起思考' }).parentElement
      ).toHaveTextContent('checking the plan')
    );
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

  it('styles thinking markdown content with secondary muted text color instead of primary body color', () => {
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-content\s+\.conv-markdown[\s\S]*?--color-text-primary:\s*var\(--conv-text-secondary,\s*var\(--text-muted\)\)/
    );
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-content\s+\.conv-markdown[\s\S]*?color:\s*var\(--conv-text-secondary,\s*var\(--text-muted\)\)/
    );
  });
});
