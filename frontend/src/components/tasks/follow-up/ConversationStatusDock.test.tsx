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

  it('keeps warning details collapsed until the user asks to inspect them', () => {
    render(
      <ConversationStatusDock
        notices={[
          {
            id: 'notice-load-failed',
            kind: 'session-notice',
            notice: {
              title: '加载代理会话失败',
              message: 'session/load failed: no rollout found',
              severity: 'warning',
            },
          },
        ]}
      />
    );

    expect(screen.getByText('加载代理会话失败')).toBeInTheDocument();
    expect(
      screen.queryByText('session/load failed: no rollout found')
    ).not.toBeInTheDocument();

    const detailsButton = screen.getByRole('button', {
      name: '查看详细信息：加载代理会话失败',
    });
    expect(detailsButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(detailsButton);

    expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('session/load failed: no rollout found')
    ).toBeInTheDocument();
  });

  it('keeps local, turn, and interruption details behind disclosure controls', () => {
    render(
      <ConversationStatusDock
        localError="prompt enhancement failed: request timed out"
        notices={[
          {
            id: 'error-turn-1',
            kind: 'turn-error',
            error: {
              message: 'agent connection closed unexpectedly',
              code: 'connection_closed',
              raw: null,
            },
          },
          {
            id: 'interrupted-turn-2',
            kind: 'interrupted-turn',
          },
        ]}
      />
    );

    expect(screen.getByText('操作失败')).toBeInTheDocument();
    expect(screen.getByText('连接已断开')).toBeInTheDocument();
    expect(screen.getByText('因重启中断')).toBeInTheDocument();
    expect(
      screen.queryByText('prompt enhancement failed: request timed out')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('agent connection closed unexpectedly')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('此回合在生成过程中因应用重启而中断，未能完成。')
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '查看详细信息：操作失败' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: '查看详细信息：连接已断开' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: '查看详细信息：因重启中断' })
    );

    expect(
      screen.getByText('prompt enhancement failed: request timed out')
    ).toBeInTheDocument();
    expect(
      screen.getByText('agent connection closed unexpectedly')
    ).toBeInTheDocument();
    expect(
      screen.getByText('此回合在生成过程中因应用重启而中断，未能完成。')
    ).toBeInTheDocument();
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

  it('allows turn failures, interruptions, and local send errors to be dismissed', () => {
    const onDismissLocalError = vi.fn();
    render(
      <ConversationStatusDock
        dismissalScope="session-1"
        localError="send failed"
        onDismissLocalError={onDismissLocalError}
        notices={[
          {
            id: 'error-turn-1',
            kind: 'turn-error',
            error: {
              message: 'agent connection closed',
              code: 'connection_closed',
              raw: null,
            },
          },
          {
            id: 'interrupted-turn-2',
            kind: 'interrupted-turn',
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭本地错误提示' }));
    expect(onDismissLocalError).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole('button', { name: '关闭提示 error-turn-1' })
    );
    expect(screen.queryByText('连接已断开')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: '关闭提示 interrupted-turn-2' })
    );
    expect(screen.queryByText('因重启中断')).not.toBeInTheDocument();
  });
});
