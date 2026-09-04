import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationDelegationView } from 'shared/types';
import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { DelegationCard } from './DelegationCard';

vi.mock('../AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="markdown">{value}</div>
  ),
}));

function running(
  overrides: Partial<ConversationDelegationView> = {}
): ConversationDelegationView {
  return {
    delegation_id: 'delegation-1',
    parent_tool_call_id: 'tool-1',
    child_conversation_id: 'child-conversation-1',
    agent_id: 'codex' as const,
    task_preview: 'Review the diff',
    status: 'running',
    result: null,
    ...overrides,
  };
}

function renderCard(card: React.ReactElement) {
  const transport = {
    environment: 'desktop',
    call: vi.fn().mockResolvedValue(undefined),
  } satisfies BackendTransport;
  return render(
    <BackendTransportProvider transport={transport}>
      {card}
    </BackendTransportProvider>
  );
}

function cardContains(node: HTMLElement): boolean {
  return Boolean(screen.getByTestId('host-delegation-card').contains(node));
}

describe('DelegationCard', () => {
  it('shows the running host delegation with its agent mark and collapsed task', () => {
    renderCard(<DelegationCard delegation={running()} />);

    expect(screen.getByRole('group', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByTestId('host-delegation-card')).toBeInTheDocument();
    expect(screen.getByTitle('Codex')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '任务' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent('Review the diff');
  });

  it('shows the full task and final result in the disclosure well', () => {
    const task =
      'Please introduce yourself to the user in Chinese. Goal: Write a brief self-introduction as Codex (OpenAI Codex). This is a social/intro request, not a coding task. Do not modify any files, run commands, or use tools.';
    const result =
      '你好，我是 Codex，OpenAI 的编程助手。我擅长编写、调试和审查代码。';
    renderCard(
      <DelegationCard
        delegation={running({
          task_preview: task,
          status: 'completed',
          result: {
            kind: 'ok',
            text_preview: result,
            duration_ms: 1500n,
          },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(task);
    expect(screen.getByTestId('host-delegation-well').className).toContain(
      'overflow-y-auto'
    );

    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(result);
  });

  it('renders the completion result preview and duration', () => {
    renderCard(
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
    expect(screen.getByText('耗时 1.5 秒')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent('All good');
  });

  it('renders a failure with the real error message', () => {
    renderCard(
      <DelegationCard
        delegation={running({
          status: 'failed',
          result: {
            kind: 'err',
            error: { message: 'sub-agent crashed', kind: 'unknown' },
          },
        })}
      />
    );

    expect(screen.getByText('失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'sub-agent crashed'
    );
  });

  it('renders a canceled delegation as canceled instead of failed', () => {
    renderCard(
      <DelegationCard
        delegation={running({
          status: 'canceled',
          result: {
            kind: 'err',
            error: {
              message: 'canceled by request',
              code: 'canceled',
              kind: 'cancelled',
            },
          },
        })}
      />
    );

    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByText('失败')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'canceled by request'
    );
  });

  it('opens the child transcript with the real child conversation id', () => {
    const onOpenChild = vi.fn();
    renderCard(
      <DelegationCard delegation={running()} onOpenChild={onOpenChild} />
    );

    fireEvent.click(screen.getByRole('button', { name: /查看会话/ }));

    expect(onOpenChild).toHaveBeenCalledWith('child-conversation-1');
  });

  it('puts the agent name, status, and view action on one header row', () => {
    renderCard(
      <DelegationCard
        delegation={running({
          status: 'completed',
          result: {
            kind: 'ok',
            text_preview: 'All good',
            duration_ms: 1500n,
          },
        })}
        onOpenChild={vi.fn()}
      />
    );

    expect(screen.getByRole('group', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.queryByText('委派给 Codex')).toBeNull();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /查看会话/ })
    ).toBeInTheDocument();
    expect(screen.getByText('耗时 1.5 秒')).toBeInTheDocument();
  });

  it('keeps the icon in a left column and duration on the task row', () => {
    renderCard(
      <DelegationCard
        delegation={running({
          status: 'completed',
          result: {
            kind: 'ok',
            text_preview: 'All good',
            duration_ms: 1500n,
          },
        })}
        onOpenChild={vi.fn()}
      />
    );

    const body = screen.getByTestId('host-delegation-body');
    expect(body.className).toContain('px-5');
    expect(body.className).toContain('py-4');

    const icon = screen.getByTestId('host-delegation-agent-icon');
    const name = screen.getByTestId('host-delegation-agent-name');
    expect(name.className).toContain('host-delegation-wide-only');
    const open = screen.getByRole('button', { name: /查看会话/ });
    const task = screen.getByRole('button', { name: '任务' });
    const result = screen.getByRole('button', { name: '结果' });
    const duration = screen.getByTestId('host-delegation-duration');

    expect(icon.className).toContain('self-center');
    expect(
      icon.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      name.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(open.className).toContain('text-[11px]');
    expect(task.className).toContain('text-xs');
    expect(result.className).toContain('text-xs');
    expect(duration.className).toContain('text-xs');
    expect(duration.closest('.host-delegation-wide-only')).not.toBeNull();
    expect(
      task.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('opens task and result copy inside the card well', () => {
    renderCard(
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

    expect(screen.queryByTestId('host-delegation-well')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    const well = screen.getByTestId('host-delegation-well');
    expect(well).toHaveTextContent('Review the diff');
    expect(cardContains(well)).toBe(true);
    expect(well.className).not.toContain('ml-8');
    expect(well.className).not.toContain('host-delegation-wide-only');
    expect(well.className).toContain('px-3');
    expect(screen.getByTestId('host-delegation-body').contains(well)).toBe(
      true
    );

    fireEvent.click(screen.getByRole('button', { name: '结果' }));
    expect(screen.getByTestId('host-delegation-well')).toHaveTextContent(
      'All good'
    );
  });

  it('hides the open-child action when navigation is unavailable', () => {
    renderCard(<DelegationCard delegation={running()} />);

    expect(screen.queryByRole('button', { name: /查看会话/ })).toBeNull();
  });

  it('cancels a running delegation through the active remote transport', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const transport = {
      environment: 'web',
      call,
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1',
        protocol_version: '1.0',
        minimum_client_version: '0.1',
        capabilities: ['delegation.cancel'],
      }),
    } satisfies BackendTransport;
    render(
      <BackendTransportProvider transport={transport}>
        <DelegationCard delegation={running()} />
      </BackendTransportProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /取消委派/ }));

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('delegation_cancel', {
        childConversationId: 'child-conversation-1',
      })
    );
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });
});
