import { describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ConversationError } from 'shared/types';
import { TurnErrorCard } from './TurnErrorCard';

function err(overrides: Partial<ConversationError> = {}): ConversationError {
  const merged: ConversationError = {
    message: 'boom',
    code: null,
    raw: null,
    kind: 'unknown',
    ...overrides,
  };
  if (overrides.kind == null) {
    merged.kind = kindFromCode(merged.code ?? null);
  }
  return merged;
}

function kindFromCode(code: string | null): ConversationError['kind'] {
  switch (code) {
    case 'invalid_request':
    case 'invalid_params':
      return 'rejected';
    case 'internal_error':
      return 'service_error';
    case 'request_cancelled':
    case 'cancelled':
      return 'cancelled';
    case 'auth_required':
      return 'auth_required';
    case 'resource_not_found':
      return 'resource_not_found';
    case 'session_resume_unsupported':
      return 'session_resume_unsupported';
    case 'session_load_failed':
      return 'session_load_failed';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'connection_closed':
      return 'connection_closed';
    case 'prompt_conflict':
      return 'prompt_conflict';
    default:
      return 'unknown';
  }
}

describe('TurnErrorCard', () => {
  it('treats a cancellation as a neutral notice without a reload action', () => {
    render(
      <TurnErrorCard error={err({ code: 'cancelled' })} onReload={vi.fn()} />
    );

    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
  });

  it('renders an expired-session error with a rebind action', async () => {
    const onRebind = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'resource_not_found', message: '' })}
        onReload={vi.fn()}
        onRebind={onRebind}
      />
    );

    expect(screen.getByText('代理会话已过期')).toBeInTheDocument();
    const rebindButton = screen.getByRole('button', { name: /重新绑定会话/ });
    fireEvent.click(rebindButton);
    expect(onRebind).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rebindButton).not.toBeDisabled());
  });

  it('explains an idle-timeout (agent stopped responding) with reload', async () => {
    const onReload = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'idle_timeout', message: 'whatever backend said' })}
        onReload={onReload}
      />
    );

    expect(screen.getByText('代理无响应')).toBeInTheDocument();
    const reloadButton = screen.getByRole('button', { name: /重新加载会话/ });
    fireEvent.click(reloadButton);
    expect(onReload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reloadButton).not.toBeDisabled());
  });

  it('explains a closed connection with reload', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'connection_closed' })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('连接已断开')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
  });

  it('surfaces an auth error without offering reload', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'auth_required', message: 'login first' })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('需要重新认证')).toBeInTheDocument();
    expect(screen.getByText('login first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
  });

  it('shows the message and the raw code for an unmapped failure', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'rpc_-32050', message: 'model unavailable' })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('会话出错')).toBeInTheDocument();
    expect(
      screen.getByText('model unavailable（rpc_-32050）')
    ).toBeInTheDocument();
  });

  it('falls back to a generic error when there is no code', () => {
    render(<TurnErrorCard error={err({ message: 'something failed' })} />);

    expect(screen.getByText('会话出错')).toBeInTheDocument();
    expect(screen.getByText('something failed')).toBeInTheDocument();
  });

  it('allows a timeline error to be dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'connection_closed' })}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid requests without offering retry', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'rejected', code: 'invalid_params' })}
        onReload={vi.fn()}
        onRebind={vi.fn()}
      />
    );

    expect(screen.getByText('请求被拒绝')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /重新绑定会话/ })
    ).toBeInTheDocument();
  });

  it('offers retry for a service error', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'service_error', code: 'internal_error' })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('服务故障')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
  });

  it('offers retry for a structured rate limit', () => {
    render(
      <TurnErrorCard
        error={err({ kind: 'rate_limited', code: 'rpc_-32000' })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('已触发限流')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /重新加载会话/ })
    ).toBeInTheDocument();
  });

  it('does not classify rate-limit wording as rate_limited', () => {
    render(
      <TurnErrorCard
        error={err({
          kind: 'unknown',
          message: 'rate limit exceeded',
          code: 'rpc_-32050',
        })}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByText('会话出错')).toBeInTheDocument();
    expect(screen.queryByText('已触发限流')).toBeNull();
  });

  it('puts composer recovery actions beside the title and replaces the icon with a badge', () => {
    render(
      <TurnErrorCard
        error={err({ code: 'connection_closed' })}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
        placement="composer"
      />
    );

    const title = screen.getByText('连接已断开');
    const header = title.closest('.composer-status-header');

    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText('Error')).toHaveClass(
      'astryx-badge'
    );
    expect(
      within(header as HTMLElement).getByRole('button', {
        name: /重新加载会话/,
      })
    ).toBeInTheDocument();
    expect(
      within(header as HTMLElement).getByRole('button', { name: '关闭提示' })
    ).toBeInTheDocument();
    expect(
      title
        .closest('.composer-status-row')
        ?.querySelector('.composer-status-icon')
    ).toBeNull();
  });
});
