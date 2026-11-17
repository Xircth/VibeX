import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActiveExecutorProfileProvider,
  useActiveExecutorProfile,
} from '@/contexts/ActiveExecutorProfileContext';
import {
  beginPendingForkHandoff,
  endPendingForkHandoff,
} from '@/features/conversation/pendingForkStore';
import {
  ContextHandoffDivider,
  ConversationTailHandoff,
  TimelineAgentHandoffRow,
  formatHandoffModelLabel,
  formatHandoffTokens,
} from './ContextHandoffDivider';

function Publisher({
  sessionId,
  fromAgent,
  toAgent,
  fromModelLabel,
  toModelLabel,
}: {
  sessionId: string;
  fromAgent: 'claude_code' | 'antigravity' | 'codex';
  toAgent: 'claude_code' | 'antigravity' | 'codex';
  fromModelLabel: string | null;
  toModelLabel: string | null;
}) {
  const { setPendingAgentHandoff } = useActiveExecutorProfile();
  return (
    <button
      type="button"
      onClick={() =>
        setPendingAgentHandoff({
          sessionId,
          fromAgent,
          toAgent,
          fromModelLabel,
          toModelLabel,
          continuationPolicy: 'portable',
        })
      }
    >
      Publish Handoff
    </button>
  );
}

function wrapWithProviders(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ActiveExecutorProfileProvider>{children}</ActiveExecutorProfileProvider>
    </QueryClientProvider>
  );
}

describe('ContextHandoffDivider', () => {
  it('formats raw model identifiers cleanly while keeping friendly labels intact', () => {
    expect(formatHandoffModelLabel('Claude Opus 5.5')).toBe('Opus 5.5');
    expect(formatHandoffModelLabel('claude-opus-4-6-20250929')).toBe(
      'Opus 4.6'
    );
    expect(formatHandoffModelLabel('gemini-4-carbon')).toBe('4 Carbon');
    expect(formatHandoffModelLabel('gpt-5.4-codex')).toBe('GPT-5.4-codex');
  });

  it('formats handoff token counts cleanly', () => {
    expect(formatHandoffTokens(null)).toBeNull();
    expect(formatHandoffTokens(0)).toBeNull();
    expect(formatHandoffTokens(293)).toBe('293 Tokens');
    expect(formatHandoffTokens(1000)).toBe('1K Tokens');
    expect(formatHandoffTokens(2200)).toBe('2.2K Tokens');
    expect(formatHandoffTokens(1_200_000)).toBe('1.2M Tokens');
  });

  it('renders horizontal handoff divider with source and target models and formatted token count', () => {
    render(
      <ContextHandoffDivider
        fromAgent="claude_code"
        toAgent="antigravity"
        fromLabel="Opus 5.5"
        toLabel="4 Carbon"
        handoffTokens={2200}
      />
    );

    const divider = screen.getByTestId('context-handoff-divider');
    expect(divider).toBeInTheDocument();
    expect(screen.getByTestId('context-handoff-tokens')).toHaveTextContent(
      '2.2K Tokens'
    );
    expect(screen.getByTestId('context-handoff-from-label')).toHaveTextContent(
      'Opus 5.5'
    );
    expect(screen.getByTestId('context-handoff-to-label')).toHaveTextContent(
      '4 Carbon'
    );
  });

  it('renders TimelineAgentHandoffRow with handoffTokens when present and hides on fresh policy', () => {
    const { rerender } = render(
      wrapWithProviders(
        <TimelineAgentHandoffRow
          handoff={{
            fromAgent: 'claude_code',
            toAgent: 'codex',
            fromModel: 'claude-opus-4-6',
            toModel: null,
            handoffTokens: 2200,
            continuationPolicy: 'portable',
          }}
        />
      )
    );

    expect(screen.getByTestId('context-handoff-tokens')).toHaveTextContent(
      '2.2K Tokens'
    );

    rerender(
      wrapWithProviders(
        <TimelineAgentHandoffRow
          handoff={{
            fromAgent: 'claude_code',
            toAgent: 'codex',
            fromModel: 'claude-opus-4-6',
            toModel: null,
            handoffTokens: 2200,
            continuationPolicy: 'fresh',
          }}
        />
      )
    );

    expect(screen.queryByTestId('context-handoff-tokens')).toBeNull();
  });

  it('renders TimelineAgentHandoffRow in fork mode with Fork Handoff title', () => {
    render(
      wrapWithProviders(
        <TimelineAgentHandoffRow
          handoff={{
            handoffKind: 'fork',
            fromAgent: 'claude_code',
            toAgent: 'codex',
            fromModel: 'Grok 4.6',
            toModel: null,
            handoffTokens: 231,
            continuationPolicy: 'portable',
          }}
        />
      )
    );

    const divider = screen.getByTestId('context-handoff-divider');
    expect(divider).toHaveAttribute('data-handoff-mode', 'fork');
    expect(divider).toHaveTextContent('Fork');
    expect(screen.getByTestId('context-handoff-tokens')).toHaveTextContent(
      '231 Tokens'
    );
    expect(screen.getByTestId('context-handoff-from-label')).toHaveTextContent(
      'Grok 4.6'
    );
    expect(screen.getByTestId('context-handoff-to-label')).toHaveTextContent(
      'Codex'
    );
  });

  it('mounts ConversationTailHandoff only when the matching session has messages and an agent switch is pending', () => {
    const onReveal = vi.fn();
    render(
      wrapWithProviders(
        <>
          <Publisher
            sessionId="session-1"
            fromAgent="claude_code"
            toAgent="antigravity"
            fromModelLabel="Claude Opus 5.5"
            toModelLabel="gemini-4-carbon"
          />
          <ConversationTailHandoff
            sessionId="session-1"
            hasMessages={true}
            onReveal={onReveal}
          />
        </>
      )
    );

    expect(
      screen.queryByTestId('context-handoff-divider')
    ).not.toBeInTheDocument();

    act(() => {
      screen.getByRole('button', { name: 'Publish Handoff' }).click();
    });

    expect(screen.getByTestId('context-handoff-divider')).toBeInTheDocument();
    expect(screen.getByTestId('context-handoff-from-label')).toHaveTextContent(
      'Opus 5.5'
    );
    expect(screen.getByTestId('context-handoff-to-label')).toHaveTextContent(
      '4 Carbon'
    );
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('renders ConversationTailHandoff in forking mode while a fork request is in flight', () => {
    const onReveal = vi.fn();
    render(
      wrapWithProviders(
        <ConversationTailHandoff
          sessionId="session-fork"
          hasMessages={true}
          fallbackFromModel="Grok 4.6"
          onReveal={onReveal}
        />
      )
    );

    expect(
      screen.queryByTestId('context-handoff-divider')
    ).not.toBeInTheDocument();

    let pendingId = 0;
    act(() => {
      pendingId = beginPendingForkHandoff({
        sessionId: 'session-fork',
        fromAgent: 'claude_code',
        toAgent: 'codex',
      });
    });

    const divider = screen.getByTestId('context-handoff-divider');
    expect(divider).toHaveAttribute('data-handoff-mode', 'forking');
    expect(screen.getByTestId('context-handoff-from-label')).toHaveTextContent(
      'Grok 4.6'
    );
    expect(screen.getByTestId('context-handoff-to-label')).toHaveTextContent(
      'Codex'
    );
    expect(screen.queryByTestId('context-handoff-tokens')).toBeNull();
    expect(onReveal).toHaveBeenCalledTimes(1);

    act(() => {
      endPendingForkHandoff(pendingId);
    });

    expect(
      screen.queryByTestId('context-handoff-divider')
    ).not.toBeInTheDocument();
  });
});
