import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LogsSettings } from './LogsSettings';

const desktopApiMock = vi.hoisted(() => ({
  getLogSettings: vi.fn(),
  setLogSettings: vi.fn(),
  getRecentLogs: vi.fn(),
  getLogsDir: vi.fn(),
  revealInFileManager: vi.fn(),
  subscribeLogAppended: vi.fn(),
  subscribeLogSettingsChanged: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  desktopApi: desktopApiMock,
}));

describe('LogsSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(desktopApiMock)) fn.mockReset();
    desktopApiMock.getLogSettings.mockResolvedValue({
      level: 'info',
      targets: [],
      env_locked: false,
    });
    desktopApiMock.getRecentLogs.mockResolvedValue([
      {
        seq: 1,
        timestamp_ms: Date.parse('2026-01-01T10:41:22.993Z'),
        level: 'INFO',
        target: 'agents',
        message: 'first line',
      },
    ]);
    desktopApiMock.getLogsDir.mockResolvedValue('/tmp/vibex-logs');
    desktopApiMock.revealInFileManager.mockResolvedValue(undefined);
    desktopApiMock.setLogSettings.mockResolvedValue({
      level: 'debug',
      targets: [],
    });
    desktopApiMock.subscribeLogAppended.mockResolvedValue(() => undefined);
    desktopApiMock.subscribeLogSettingsChanged.mockResolvedValue(
      () => undefined
    );
  });

  it('loads, refreshes, and reveals the real log directory', async () => {
    const user = userEvent.setup();
    render(<LogsSettings />);

    expect(await screen.findByText(/first line/)).toBeVisible();
    expect(
      screen.getByRole('combobox', { name: '采集级别' })
    ).toHaveTextContent('信息');
    expect(desktopApiMock.getRecentLogs).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(desktopApiMock.getRecentLogs).toHaveBeenCalledTimes(2);
    });

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => {
      expect(desktopApiMock.revealInFileManager).toHaveBeenCalledWith(
        '/tmp/vibex-logs'
      );
    });
  });

  it('saves a per-module override', async () => {
    const user = userEvent.setup();
    render(<LogsSettings />);
    expect(await screen.findByText(/first line/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: '添加' }));

    expect(screen.getByRole('combobox', { name: '模块' })).toHaveTextContent(
      'agents'
    );
    expect(screen.getByRole('combobox', { name: '级别' })).toHaveTextContent(
      '调试'
    );
    await waitFor(() => {
      expect(desktopApiMock.setLogSettings).toHaveBeenCalledWith({
        level: 'info',
        targets: [{ target: 'agents', level: 'debug' }],
      });
    });
  });

  it('uses one grouped settings surface for the log contents', async () => {
    const { container } = render(<LogsSettings />);
    expect(await screen.findByText(/first line/)).toBeVisible();
    expect(container.querySelector('.settings-card .settings-card')).toBeNull();
  });
});
