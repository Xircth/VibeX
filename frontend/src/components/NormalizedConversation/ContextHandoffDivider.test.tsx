import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ActiveExecutorProfileProvider,
  useActiveExecutorProfile,
} from '@/contexts/ActiveExecutorProfileContext';
import {
  ContextHandoffDivider,
  ConversationTailHandoff,
  formatHandoffModelLabel,
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
    expect(formatHandoffModelLabel('claude-opus-4-6-20250929')).toBe('Opus 4.6');
    expect(formatHandoffModelLabel('gemini-4-carbon')).toBe('4 Carbon');
    expect(formatHandoffModelLabel('gpt-5.4-codex')).toBe('GPT-5.4-codex');
  });

  it('renders T3 Code-style horizontal context handoff divider with source and target models', () => {
    render(
      <ContextHandoffDivider
        fromAgent="claude_code"
        toAgent="antigravity"
        fromLabel="Opus 5.5"
        toLabel="4 Carbon"
      />
    );

    const divider = screen.getByTestId('context-handoff-divider');
    expect(divider).toBeInTheDocument();
    expect(screen.getByTestId('context-handoff-from-label')).toHaveTextContent(
      'Opus 5.5'
    );
    expect(screen.getByTestId('context-handoff-to-label')).toHaveTextContent(
      '4 Carbon'
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
});
