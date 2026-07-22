import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationStatusDock } from './ConversationStatusDock';

describe('ConversationStatusDock', () => {
  it('groups current errors and notices directly above the composer actions', async () => {
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onResend = vi.fn();

    render(
      <ConversationStatusDock
        notices={[
          {
            id: 'error-turn-1',
            kind: 'turn-error',
            error: {
              message: 'agent connection closed',
              code: 'connection_closed',
              raw: null,
            },
            onReload,
          },
          {
            id: 'interrupted-turn-2',
            kind: 'interrupted-turn',
            onResend,
          },
          {
            id: 'notice-3',
            kind: 'session-notice',
            notice: {
              title: '代理不支持会话恢复',
              message: '已自动新建会话继续。',
              severity: 'info',
            },
          },
        ]}
      />
    );

    const dock = screen.getByTestId('conversation-status-dock');
    expect(dock).toHaveTextContent('连接已断开');
    expect(dock).toHaveTextContent('因重启中断');
    expect(dock).toHaveTextContent('代理不支持会话恢复');

    fireEvent.click(screen.getByRole('button', { name: '重发' }));
    const reloadButton = screen.getByRole('button', {
      name: /重新加载会话/,
    });
    fireEvent.click(reloadButton);
    expect(onResend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reloadButton).not.toBeDisabled());
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
