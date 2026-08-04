import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { SystemSettings } from './SystemSettings';

const api = vi.hoisted(() => ({
  getSettingsPath: vi.fn(),
  getSystemMaintenanceStatus: vi.fn(),
  getProxy: vi.fn(),
  getRendering: vi.fn(),
}));

const userSystem = vi.hoisted(() => ({
  useUserSystem: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  backupApi: {},
  configApi: {
    getSettingsPath: api.getSettingsPath,
    getSystemMaintenanceStatus: api.getSystemMaintenanceStatus,
  },
  systemSettingsApi: {
    getProxy: api.getProxy,
    getRendering: api.getRendering,
  },
}));

vi.mock('@/components/ConfigProvider', () => userSystem);

vi.mock('@/components/settings/AppUpdaterSection', () => ({
  AppUpdaterSection: () => null,
}));

vi.mock('@/features/conversation/ConversationBundle', () => ({
  ConversationBundlePanel: () => null,
}));

describe('SystemSettings', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
    userSystem.useUserSystem.mockReset();
    userSystem.useUserSystem.mockReturnValue({
      config: {
        auto_update_enabled: true,
        auto_install_local_dependencies: true,
        editor: {},
      } as Config,
      loading: false,
      updateAndSaveConfig: vi.fn(),
    });
    api.getSettingsPath.mockResolvedValue('/Users/test/.vibex/settings.json');
    api.getSystemMaintenanceStatus.mockResolvedValue({
      app: {
        current_version: '1.0.0',
        latest_version: null,
        update_available: false,
        release_url: null,
        repository: null,
        checked: true,
        error: null,
      },
      npm: {
        name: 'npm',
        available: true,
        path: '/usr/bin/npm',
        message: 'available',
      },
      tools: [],
    });
    api.getProxy.mockResolvedValue({ enabled: false, proxy_url: null });
    api.getRendering.mockResolvedValue({ acceleration_mode: 'auto' });
  });

  it('shows the shared JSON settings source on the system page', async () => {
    render(<SystemSettings />);

    expect(
      await screen.findByText(/JSON 设置源|JSON source/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText('/Users/test/.vibex/settings.json')
    ).toBeInTheDocument();
  });
});
