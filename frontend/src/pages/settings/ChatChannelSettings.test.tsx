import { act, render, screen, waitFor, within } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatChannelSettings } from './ChatChannelSettings';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  statuses: vi.fn(),
  messageLogs: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  saveToken: vi.fn(),
  hasToken: vi.fn(),
  deleteToken: vi.fn(),
  test: vi.fn(),
  getEventFilter: vi.fn(),
  setEventFilter: vi.fn(),
  getCommandPrefix: vi.fn(),
  setCommandPrefix: vi.fn(),
  getIncludePromptText: vi.fn(),
  setIncludePromptText: vi.fn(),
  getWebhooks: vi.fn(),
  setWebhooks: vi.fn(),
  getLanguage: vi.fn(),
  setLanguage: vi.fn(),
  weixinGetQrcode: vi.fn(),
  weixinCheckQrcode: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastDismiss: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  chatChannelApi: {
    list: mocks.list,
    statuses: mocks.statuses,
    messageLogs: mocks.messageLogs,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.delete,
    saveToken: mocks.saveToken,
    hasToken: mocks.hasToken,
    deleteToken: mocks.deleteToken,
    test: mocks.test,
    getEventFilter: mocks.getEventFilter,
    setEventFilter: mocks.setEventFilter,
    getCommandPrefix: mocks.getCommandPrefix,
    setCommandPrefix: mocks.setCommandPrefix,
    getIncludePromptText: mocks.getIncludePromptText,
    setIncludePromptText: mocks.setIncludePromptText,
    getWebhooks: mocks.getWebhooks,
    setWebhooks: mocks.setWebhooks,
    getLanguage: mocks.getLanguage,
    setLanguage: mocks.setLanguage,
    weixinGetQrcode: mocks.weixinGetQrcode,
    weixinCheckQrcode: mocks.weixinCheckQrcode,
  },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    dismiss: mocks.toastDismiss,
  },
}));

const channel = {
  id: 'channel-1',
  name: 'Team notifications',
  kind: 'telegram',
  enabled: true,
  config: { chat_id: '-100123', authorized_senders: ['42'] },
  has_token: true,
  created_at: '2026-08-03T00:00:00Z',
  updated_at: '2026-08-03T00:00:00Z',
};

function renderSettings() {
  return render(
    <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
      <ChatChannelSettings />
    </HotkeysProvider>
  );
}

describe('ChatChannelSettings', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.list.mockResolvedValue([]);
    mocks.statuses.mockResolvedValue([]);
    mocks.messageLogs.mockResolvedValue([]);
    mocks.getEventFilter.mockResolvedValue({
      enabled_events: ['prompt_started'],
    });
    mocks.getCommandPrefix.mockResolvedValue({ prefix: '/vibex' });
    mocks.getIncludePromptText.mockResolvedValue(false);
    mocks.getWebhooks.mockResolvedValue([]);
    mocks.getLanguage.mockResolvedValue('en');
    mocks.setEventFilter.mockImplementation(async (filter) => filter);
    mocks.setCommandPrefix.mockImplementation(async (prefix) => prefix);
    mocks.setIncludePromptText.mockImplementation(async (enabled) => enabled);
    mocks.setWebhooks.mockImplementation(async (hooks) => hooks);
    mocks.toastWarning.mockReturnValue('toast-id');
  });

  it('opens an accessible create dialog and persists a Telegram channel', async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.create.mockResolvedValue(channel);
    renderSettings();

    await user.click(await screen.findByRole('button', { name: '新建渠道' }));
    const dialog = screen.getByRole('dialog', { name: '新建渠道' });
    await user.type(within(dialog).getByLabelText('名称'), channel.name);
    await user.type(within(dialog).getByLabelText('Chat ID'), '-100123');
    await user.type(within(dialog).getByLabelText('Bot Token'), 'secret-token');
    await user.type(within(dialog).getByLabelText(/授权发送者/), '42');
    await user.click(within(dialog).getByRole('button', { name: '新建' }));

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        name: channel.name,
        kind: 'telegram',
        enabled: true,
        config: {
          chat_id: '-100123',
          topic_mode: false,
          daily_report_enabled: false,
          daily_report_time: '18:00',
          authorized_senders: ['42'],
        },
        token: 'secret-token',
      });
    });

    const renderedWarnings = consoleError.mock.calls.flat().join(' ');
    consoleError.mockRestore();
    expect(renderedWarnings).not.toContain(
      '<button> cannot appear as a descendant of <button>'
    );
  });

  it('switches among 渠道, 指令, and 事件 without an 其他 tab', async () => {
    const user = userEvent.setup();
    renderSettings();

    const tablist = await screen.findByRole('tablist', {
      name: '消息渠道分区',
    });
    expect(within(tablist).getByRole('tab', { name: '渠道' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(within(tablist).queryByRole('tab', { name: '其他' })).toBeNull();
    expect(screen.getByRole('heading', { name: '消息渠道' })).toBeVisible();
    expect(await screen.findByText('暂无渠道')).toBeVisible();

    await user.click(within(tablist).getByRole('tab', { name: '指令' }));
    expect(screen.getByLabelText('命令前缀')).toBeVisible();
    expect(screen.getByText('/vibex folder [n|name]')).toBeVisible();
    expect(screen.getByText('/vibex resume [n|id]')).toBeVisible();
    expect(screen.queryByText('/vibex ping')).not.toBeInTheDocument();
    expect(screen.queryByText('暂无渠道')).not.toBeInTheDocument();

    await user.click(within(tablist).getByRole('tab', { name: '事件' }));
    expect(screen.getByRole('switch', { name: '任务开始' })).toBeVisible();
    expect(screen.getByText('事件 Webhook')).toBeVisible();
    expect(screen.getByText('负载示例')).toBeVisible();
  });

  it('persists event filters, prompt privacy, and the command prefix', async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    renderSettings();

    await user.click(await screen.findByRole('tab', { name: '事件' }));
    await user.click(screen.getByRole('switch', { name: '任务结束' }));
    await user.click(
      screen.getByRole('switch', { name: '在通知中包含提示词内容' })
    );

    await user.click(screen.getByRole('tab', { name: '指令' }));
    const prefixInput = screen.getByLabelText('命令前缀');
    await user.clear(prefixInput);
    await user.type(prefixInput, '/team');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocks.setEventFilter).toHaveBeenCalledWith({
        enabled_events: ['prompt_started', 'prompt_finished'],
      });
      expect(mocks.setIncludePromptText).toHaveBeenCalledWith(true);
      expect(mocks.setCommandPrefix).toHaveBeenCalledWith({ prefix: '/team' });
    });

    const renderedWarnings = consoleError.mock.calls.flat().join(' ');
    consoleError.mockRestore();
    expect(renderedWarnings).not.toContain(
      '<button> cannot appear as a descendant of <button>'
    );
  });

  it('toggles, tests, audits, and deletes an existing channel', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([channel]);
    mocks.update.mockResolvedValue({ ...channel, enabled: false });
    mocks.test.mockResolvedValue({ ok: true, status: 200, message: 'sent' });
    mocks.delete.mockResolvedValue(undefined);
    renderSettings();

    await user.click(await screen.findByRole('switch', { name: '停用渠道' }));
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        'channel-1',
        expect.objectContaining({ enabled: false, token: null })
      );
    });

    await user.click(screen.getByRole('switch', { name: '启用渠道' }));
    await waitFor(() => {
      expect(mocks.update).toHaveBeenLastCalledWith(
        'channel-1',
        expect.objectContaining({ enabled: true, token: null })
      );
    });

    await user.click(
      screen.getByRole('button', { name: /Team notifications/ })
    );
    await user.click(screen.getByRole('button', { name: '测试发送' }));
    await waitFor(() => expect(mocks.test).toHaveBeenCalledWith('channel-1'));

    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '投递记录' }));
    expect(mocks.messageLogs).toHaveBeenCalledWith('channel-1', 15);

    await user.click(screen.getByRole('button', { name: '删除渠道' }));
    const options = mocks.toastWarning.mock.calls.at(-1)?.[1];
    await act(async () => options.action.onClick());
    expect(mocks.delete).toHaveBeenCalledWith('channel-1');
  });
});
