import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LogsSettings } from './LogsSettings';

const desktopApiMock = vi.hoisted(() => ({
  getAppLogs: vi.fn(),
  getLogsDir: vi.fn(),
  revealInFileManager: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  desktopApi: desktopApiMock,
}));

describe('LogsSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(desktopApiMock)) fn.mockReset();
    desktopApiMock.getAppLogs.mockResolvedValue(['first line', 'second line']);
    desktopApiMock.getLogsDir.mockResolvedValue('/tmp/vibex-logs');
    desktopApiMock.revealInFileManager.mockResolvedValue(undefined);
  });

  it('loads, refreshes, and reveals the real log directory', async () => {
    const user = userEvent.setup();
    render(<LogsSettings />);

    expect(await screen.findByText(/first line/)).toBeVisible();
    expect(desktopApiMock.getAppLogs).toHaveBeenCalledWith(500);

    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(desktopApiMock.getAppLogs).toHaveBeenCalledTimes(2);
    });

    await user.click(screen.getByRole('button', { name: '打开文件夹' }));
    await waitFor(() => {
      expect(desktopApiMock.revealInFileManager).toHaveBeenCalledWith(
        '/tmp/vibex-logs'
      );
    });
  });

  it('uses one grouped settings surface for the log contents', async () => {
    const { container } = render(<LogsSettings />);
    expect(await screen.findByText(/first line/)).toBeVisible();

    expect(container.querySelector('.settings-card .settings-card')).toBeNull();
  });
});
