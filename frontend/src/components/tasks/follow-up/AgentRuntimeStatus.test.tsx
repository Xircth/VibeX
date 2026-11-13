import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeStatus } from './AgentRuntimeStatus';
import type { ConversationSessionNotice } from 'shared/types';
const notice: ConversationSessionNotice = {
  title: 'Agent request',
  severity: 'info',
  request_status: {
    turn_id: 't',
    prompt_id: 'p',
    connection_id: 'c',
    since: '2026-11-13T00:00:00Z',
    activity: {
      phase: 'retrying',
      retry: {
        attempt: 2,
        max_attempts: 5,
        delay_ms: 3000n,
        reason: 'provider unavailable',
        code: null,
      },
    },
  },
};
describe('AgentRuntimeStatus', () => {
  afterEach(() => vi.useRealTimers());
  it('offers cancellation while retrying and manual retry only after failure', async () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(
      <AgentRuntimeStatus
        notice={notice}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '手动重试' })).toBeNull();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'cancelling', retry: null },
          },
        }}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole('button', { name: '取消请求' })).toBeNull();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'failed', retry: null },
          },
        }}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '手动重试' }));
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it('updates a retry in place and exposes the actual reason', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    const { rerender, container } = render(
      <AgentRuntimeStatus notice={notice} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('请求重试中');
    fireEvent.click(
      screen.getByRole('button', { name: '查看详细信息: 请求重试中' })
    );
    expect(screen.getByText('provider unavailable')).toBeVisible();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'waiting_agent', retry: null },
          },
        }}
      />
    );
    expect(screen.queryByText('provider unavailable')).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-testid="agent-request-status"]')
    ).toHaveLength(1);
  });
  it('shows elapsed response wait but stops the timer at terminal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:31Z'));
    const { rerender } = render(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'waiting_agent', retry: null },
          },
        }}
      />
    );
    expect(screen.getByText('31s')).toBeVisible();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('32s')).toBeVisible();
    rerender(
      <AgentRuntimeStatus
        notice={{
          ...notice,
          request_status: {
            ...notice.request_status!,
            activity: { phase: 'failed', retry: null },
          },
        }}
      />
    );
    expect(screen.queryByText('32s')).not.toBeInTheDocument();
  });
});
