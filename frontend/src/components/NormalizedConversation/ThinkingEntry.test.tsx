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

    expect(screen.getByText('正在思考中...')).toHaveClass('conv-shimmer-text');
    expect(screen.queryByText('思考')).not.toBeInTheDocument();
    expect(document.querySelector('.conv-thinking-spinner')).toHaveClass(
      'animate-spin'
    );
    expect(document.querySelector('.conv-thinking-icon')).toBeNull();
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
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('正在思考中...')).not.toBeInTheDocument();
    expect(document.querySelector('.conv-thinking-icon')).not.toBeNull();
    expect(document.querySelector('.conv-thinking-spinner')).toBeNull();
    expect(
      screen.getByRole('button', { name: '展开思考' })
    ).toBeInTheDocument();
  });

  it('shows the settled brain label when thinking is paused before it finishes', () => {
    render(
      <ThinkingEntry
        content="partial thought"
        expansionKey="paused-thought"
        isStreaming={false}
      />
    );

    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('正在思考中...')).not.toBeInTheDocument();
    expect(document.querySelector('.conv-thinking-icon')).not.toBeNull();
    expect(document.querySelector('.conv-thinking-spinner')).toBeNull();
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

  it('sizes thinking labels to the conversation body without bolding', () => {
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-header\s*\{[^}]*font-family:\s*var\(--font-ui\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;/
    );
    expect(convToolsStyles).not.toMatch(
      /\.conv-thinking-label\s*\{[^}]*font-weight:\s*700/
    );
  });

  it('caps thinking content at 100 lines, hides the scrollbar, and disables inner scroll while streaming', () => {
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-content\s*\{[^}]*max-height:\s*100lh;[^}]*overflow-y:\s*auto;/
    );
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-content\s*\{[^}]*overscroll-behavior:\s*contain;/
    );
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-content\s*\{[^}]*scrollbar-width:\s*none;/
    );
    expect(convToolsStyles).toMatch(
      /\.conv-thinking-streaming\s+\.conv-thinking-content\s*\{[^}]*overflow:\s*hidden;/
    );
    expect(convToolsStyles).toMatch(
      /\.conv-nested-scroll\s*\{[^}]*max-height:\s*100lh;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/
    );
    expect(convToolsStyles).toMatch(
      /\.astryx-chat-tool-calls\s+\[role='button'\]\[aria-expanded='true'\]\s*\+\s*div\s*\{[^}]*max-height:\s*100lh;/
    );
  });

  it('does not hijack wheel pixels while thinking is streaming', () => {
    const { container } = render(
      <div data-panel="conversation-logs">
        <ThinkingEntry
          content={'line\n'.repeat(40)}
          expansionKey="stream-scroll"
          isStreaming
        />
      </div>
    );
    const scroller = container.firstElementChild as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollTop', {
      writable: true,
      value: 12,
    });
    const content = container.querySelector(
      '.conv-thinking-content'
    ) as HTMLDivElement;
    fireEvent.wheel(content, { deltaY: 48 });
    expect(scroller.scrollTop).toBe(12);
  });

  it('does not hijack wheel pixels when finished thinking does not overflow', () => {
    render(
      <div data-panel="conversation-logs">
        <ThinkingEntry
          content="short thought"
          expansionKey="finished-no-overflow"
          isStreaming={false}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    const scroller = document.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollTop', {
      writable: true,
      value: 12,
    });
    const content = document.querySelector(
      '.conv-thinking-content'
    ) as HTMLDivElement;
    Object.defineProperty(content, 'clientHeight', { value: 120 });
    Object.defineProperty(content, 'scrollHeight', { value: 80 });
    Object.defineProperty(content, 'scrollTop', {
      writable: true,
      value: 0,
    });
    fireEvent.wheel(content, { deltaY: 48 });
    expect(scroller.scrollTop).toBe(12);
  });

  it('keeps overflowing finished thinking until the wheel hits an edge', () => {
    render(
      <div data-panel="conversation-logs">
        <ThinkingEntry
          content={'line\n'.repeat(40)}
          expansionKey="finished-overflow"
          isStreaming={false}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    const scroller = document.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollTop', {
      writable: true,
      value: 12,
    });
    const content = document.querySelector(
      '.conv-thinking-content'
    ) as HTMLDivElement;
    Object.defineProperty(content, 'clientHeight', { value: 100 });
    Object.defineProperty(content, 'scrollHeight', { value: 400 });
    Object.defineProperty(content, 'scrollTop', {
      writable: true,
      value: 40,
    });
    fireEvent.wheel(content, { deltaY: 48 });
    expect(scroller.scrollTop).toBe(12);
  });

  it('chains finished thinking to the conversation at the bottom edge', () => {
    render(
      <div data-panel="conversation-logs">
        <ThinkingEntry
          content={'line\n'.repeat(40)}
          expansionKey="finished-edge"
          isStreaming={false}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    const scroller = document.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollTop', {
      writable: true,
      value: 12,
    });
    Object.defineProperty(scroller, 'clientHeight', { value: 200 });
    Object.defineProperty(scroller, 'scrollHeight', { value: 800 });
    const content = document.querySelector(
      '.conv-thinking-content'
    ) as HTMLDivElement;
    Object.defineProperty(content, 'clientHeight', { value: 100 });
    Object.defineProperty(content, 'scrollHeight', { value: 400 });
    Object.defineProperty(content, 'scrollTop', {
      writable: true,
      value: 300,
    });
    fireEvent.wheel(content, { deltaY: 48 });
    expect(scroller.scrollTop).toBe(60);
  });

  it('forwards overflowing thinking at an edge to the tool fold before the conversation', () => {
    render(
      <div data-panel="conversation-logs">
        <div data-nested-scroll className="conv-nested-scroll">
          <ThinkingEntry
            content={'line\n'.repeat(40)}
            expansionKey="nested-fold"
            isStreaming={false}
          />
        </div>
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    const scroller = document.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLDivElement;
    const fold = document.querySelector(
      '.conv-nested-scroll'
    ) as HTMLDivElement;
    const content = document.querySelector(
      '.conv-thinking-content'
    ) as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollTop', {
      writable: true,
      value: 12,
    });
    Object.defineProperty(fold, 'scrollTop', { writable: true, value: 8 });
    Object.defineProperty(fold, 'clientHeight', { value: 100 });
    Object.defineProperty(fold, 'scrollHeight', { value: 400 });
    Object.defineProperty(content, 'clientHeight', { value: 100 });
    Object.defineProperty(content, 'scrollHeight', { value: 400 });
    Object.defineProperty(content, 'scrollTop', {
      writable: true,
      value: 300,
    });
    fireEvent.wheel(content, { deltaY: 48 });
    expect(fold.scrollTop).toBe(56);
    expect(scroller.scrollTop).toBe(12);
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
