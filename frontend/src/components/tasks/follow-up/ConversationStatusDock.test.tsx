import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStatusDock } from './ConversationStatusDock';

describe('ConversationStatusDock', () => {
  beforeEach(() => {
    localStorage.clear();
  });

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

  it('keeps a dismissed session notice hidden while allowing newer notices', () => {
    const { rerender, unmount } = render(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '部分会话记录无法显示',
              message: '其余会话内容不受影响。',
              severity: 'warning',
            },
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByText('部分会话记录无法显示')).not.toBeInTheDocument();

    rerender(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '部分会话记录无法显示',
              message: '其余会话内容不受影响。',
              severity: 'warning',
            },
          },
        ]}
      />
    );
    expect(screen.queryByText('部分会话记录无法显示')).not.toBeInTheDocument();

    rerender(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '回退后产生的新提示',
              message: '即使复用了事件序号也应显示。',
              severity: 'warning',
            },
          },
        ]}
      />
    );
    expect(screen.getByText('回退后产生的新提示')).toBeInTheDocument();

    rerender(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-2',
            kind: 'session-notice',
            notice: {
              title: '另一条会话提示',
              message: null,
              severity: 'info',
            },
          },
        ]}
      />
    );
    expect(screen.getByText('另一条会话提示')).toBeInTheDocument();

    unmount();
    const reopened = render(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '部分会话记录无法显示',
              message: '其余会话内容不受影响。',
              severity: 'warning',
            },
          },
        ]}
      />
    );
    expect(screen.queryByText('部分会话记录无法显示')).not.toBeInTheDocument();

    reopened.unmount();
    const reusedSequence = render(
      <ConversationStatusDock
        dismissalScope="session-1"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '回退后产生的新提示',
              message: '即使复用了事件序号也应显示。',
              severity: 'warning',
            },
          },
        ]}
      />
    );
    expect(screen.getByText('回退后产生的新提示')).toBeInTheDocument();

    reusedSequence.unmount();
    render(
      <ConversationStatusDock
        dismissalScope="session-2"
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '部分会话记录无法显示',
              message: '其余会话内容不受影响。',
              severity: 'warning',
            },
          },
        ]}
      />
    );
    expect(screen.getByText('部分会话记录无法显示')).toBeInTheDocument();
  });
});
