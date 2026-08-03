import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { SystemSettings } from './SystemSettings';

const mocks = vi.hoisted(() => ({
  config: {
    auto_update_enabled: true,
    auto_install_local_dependencies: true,
    editor: { remote_ssh_host: 'old-host', remote_ssh_user: 'old-user' },
  } as Config,
  updateAndSaveConfig: vi.fn(),
  getMaintenance: vi.fn(),
  clearLocalData: vi.fn(),
  getProxy: vi.fn(),
  updateProxy: vi.fn(),
  getRendering: vi.fn(),
  updateRendering: vi.fn(),
  backupCreate: vi.fn(),
  backupInspect: vi.fn(),
  backupRestore: vi.fn(),
  backupCancel: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastLoading: vi.fn(),
  toastDismiss: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: mocks.config,
    loading: false,
    updateAndSaveConfig: mocks.updateAndSaveConfig,
  }),
}));

vi.mock('@/lib/api', () => ({
  configApi: {
    getSystemMaintenanceStatus: mocks.getMaintenance,
    clearLocalData: mocks.clearLocalData,
  },
  systemSettingsApi: {
    getProxy: mocks.getProxy,
    updateProxy: mocks.updateProxy,
    getRendering: mocks.getRendering,
    updateRendering: mocks.updateRendering,
  },
  backupApi: {
    create: mocks.backupCreate,
    inspect: mocks.backupInspect,
    restoreStage: mocks.backupRestore,
    cancel: mocks.backupCancel,
  },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
  },
}));

vi.mock('@/components/settings/AppUpdaterSection', () => ({
  AppUpdaterSection: () => <div>updater boundary</div>,
}));

vi.mock('@/features/conversation/ConversationBundle', () => ({
  ConversationBundlePanel: () => <div>conversation bundle boundary</div>,
}));

vi.mock('@/stores/useWindowProjectsStore', () => ({
  useWindowProjectsStore: {
    getState: () => ({ resetProjectWindowState: vi.fn() }),
  },
}));

const preview = {
  manifest: {
    format: 'vibex-backup',
    version: 1,
    created_at: '2026-08-03T00:00:00Z',
    app_version: '1.0.0',
    entry_count: 1,
    total_bytes: 1024,
  },
  entries: [
    {
      path: 'config.json',
      size_bytes: 1024,
      modified_at: null,
      already_exists: true,
    },
  ],
};

describe('SystemSettings', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const value of Object.values(mocks)) {
      if (typeof value === 'function' && 'mockReset' in value)
        value.mockReset();
    }
    mocks.updateAndSaveConfig.mockResolvedValue(true);
    mocks.getMaintenance.mockResolvedValue({
      app: {
        current_version: '1.0.0',
        latest_version: '1.0.0',
        update_available: false,
        release_url: null,
        repository: null,
        checked: true,
        error: null,
      },
      npm: { name: 'npm', available: true, path: '/usr/bin/npm', message: '' },
      tools: [],
    });
    mocks.getProxy.mockResolvedValue({ enabled: false, proxy_url: null });
    mocks.updateProxy.mockImplementation(async (settings) => settings);
    mocks.getRendering.mockResolvedValue({ acceleration_mode: 'auto' });
    mocks.updateRendering.mockImplementation(async (settings) => settings);
    mocks.backupCreate.mockResolvedValue(preview);
    mocks.backupInspect.mockResolvedValue(preview);
    mocks.backupRestore.mockResolvedValue({
      preview,
      restored_entries: 1,
      requires_reload: true,
    });
    mocks.toastLoading.mockReturnValue('toast-id');
    mocks.toastWarning.mockReturnValue('toast-id');
  });

  it('loads and persists proxy, rendering, and app-maintenance settings', async () => {
    const user = userEvent.setup();
    render(<SystemSettings />);

    expect(
      await screen.findByText('当前版本：1.0.0 / 最新版本：1.0.0')
    ).toBeVisible();

    const proxySection = screen.getByText('网络代理').closest('section');
    expect(proxySection).not.toBeNull();
    await user.click(within(proxySection!).getByRole('switch'));
    await user.type(
      within(proxySection!).getByPlaceholderText('http://127.0.0.1:7890'),
      'http://proxy.local:7890'
    );
    await user.click(
      within(proxySection!).getByRole('button', { name: '保存' })
    );
    await waitFor(() => {
      expect(mocks.updateProxy).toHaveBeenCalledWith({
        enabled: true,
        proxy_url: 'http://proxy.local:7890',
      });
    });

    const renderingSection = screen.getByText('渲染加速').closest('section');
    await user.click(within(renderingSection!).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '禁用 GPU' }));
    await user.click(
      within(renderingSection!).getByRole('button', { name: '保存' })
    );
    await waitFor(() => {
      expect(mocks.updateRendering).toHaveBeenCalledWith({
        acceleration_mode: 'disable_gpu',
      });
    });

    await user.click(screen.getByRole('switch', { name: '自动检查应用更新' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          auto_update_enabled: false,
          editor: expect.objectContaining({
            remote_ssh_host: null,
            remote_ssh_user: null,
          }),
        })
      );
    });
  });

  it('exports and inspects portable backups through the backend boundary', async () => {
    const user = userEvent.setup();
    render(<SystemSettings />);
    await waitFor(() => expect(mocks.getProxy).toHaveBeenCalled());

    await user.type(
      screen.getByPlaceholderText(/vibex-backup\.vibexbak/),
      '/tmp/vibex-backup.vibexbak'
    );
    await user.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => {
      expect(mocks.backupCreate).toHaveBeenCalledWith({
        path: '/tmp/vibex-backup.vibexbak',
        passphrase: null,
      });
    });

    await user.type(
      screen.getByPlaceholderText('选择或粘贴 .vibexbak 文件路径'),
      '/tmp/restore.vibexbak'
    );
    await user.click(screen.getByRole('button', { name: '预览' }));
    await waitFor(() => {
      expect(mocks.backupInspect).toHaveBeenCalledWith({
        path: '/tmp/restore.vibexbak',
        passphrase: null,
      });
    });
    expect(await screen.findByText('config.json')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '恢复' }));
    const restoreOptions = mocks.toastWarning.mock.calls.at(-1)?.[1];
    await act(async () => restoreOptions.action.onClick());
    expect(mocks.backupRestore).toHaveBeenCalledWith({
      path: '/tmp/restore.vibexbak',
      passphrase: null,
      confirmed: true,
    });

    await user.click(screen.getByRole('button', { name: '清除' }));
    const clearOptions = mocks.toastWarning.mock.calls.at(-1)?.[1];
    mocks.clearLocalData.mockResolvedValue({
      cleared: true,
      requires_reload: false,
    });
    await act(async () => clearOptions.action.onClick());
    expect(mocks.clearLocalData).toHaveBeenCalledOnce();
  });
});
