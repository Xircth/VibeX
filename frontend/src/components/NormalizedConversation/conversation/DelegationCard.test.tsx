import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationDelegationView } from 'shared/types';
import { DelegationCard } from './DelegationCard';

function running(
  overrides: Partial<ConversationDelegationView> = {}
): ConversationDelegationView {
  return {
    delegation_id: 'delegation-1',
    parent_tool_call_id: 'tool-1',
    child_conversation_id: 'child-conversation-1',
    agent_type: 'codex' as const,
    task_preview: 'Review the diff',
    status: 'running',
    result: null,
    ...overrides,
  };
}

describe('DelegationCard', () => {
  it('shows the running sub-agent with its task and agent label', () => {
    render(<DelegationCard delegation={running()} />);

    expect(screen.getByText('委派给 Codex')).toBeInTheDocument();
    expect(screen.getByText('Review the diff')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('renders the completion result preview and duration', () => {
    render(
      <DelegationCard
        delegation={running({
          status: 'completed',
          result: {
            kind: 'ok',
            text_preview: 'All good',
            duration_ms: 1500n,
          },
        })}
      />
    );

    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.getByText('耗时 1.5s')).toBeInTheDocument();
  });

  it('renders a failure with the real error message', () => {
    render(
      <DelegationCard
        delegation={running({
          status: 'failed',
          result: {
            kind: 'err',
            error: { message: 'sub-agent crashed' },
          },
        })}
      />
    );

    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('sub-agent crashed')).toBeInTheDocument();
  });

  it('opens the child transcript with the real child conversation id', () => {
    const onOpenChild = vi.fn();
    render(<DelegationCard delegation={running()} onOpenChild={onOpenChild} />);

    fireEvent.click(screen.getByRole('button', { name: /打开子会话/ }));

    expect(onOpenChild).toHaveBeenCalledWith('child-conversation-1');
  });

  it('hides the open-child action when navigation is unavailable', () => {
    render(<DelegationCard delegation={running()} />);

    expect(screen.queryByRole('button', { name: /打开子会话/ })).toBeNull();
  });
});
