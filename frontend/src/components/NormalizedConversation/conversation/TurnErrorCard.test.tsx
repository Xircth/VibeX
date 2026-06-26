import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ConversationError } from 'shared/types';
import { TurnErrorCard } from './TurnErrorCard';

function err(overrides: Partial<ConversationError> = {}): ConversationError {
  return { message: 'boom', code: null, raw: null, ...overrides };
}

describe('TurnErrorCard', () => {
  it('treats a cancellation as a neutral notice without a reload action', () => {
    render(<TurnErrorCard error={err({ code: 'cancelled' })} onReload={vi.fn()} />);

    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新加载/ })).toBeNull();
  });

  it('renders an expired-session error with a reload action', () => {
    const onReload = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'resource_not_found', message: '' })}
        onReload={onReload}
      />
    );

    expect(screen.getByText('代理会话已过期')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新加载会话/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('explains an idle-timeout (agent stopped responding) with reload', () => {
    const onReload = vi.fn();
    render(
      <TurnErrorCard
        error={err({ code: 'idle_timeout', message: 'whatever backend said' })}
        onReload={onReload}
      />
    );

    expect(screen.getByText('代理无响应')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新加载会话/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
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
});
