import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { RemoteClientSettings } from './RemoteClientSettings';

const hostClientApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  discover: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  delete: vi.fn(),
  hostUpdates: vi.fn(),
  applyHostUpdate: vi.fn(),
}));

const pluginControlApiMock = vi.hoisted(() => ({
  catalog: vi.fn(async () => ({ plugins: [], runtimes: [] })),
  contributionCatalog: vi.fn(async () => ({ generation: 0, items: [] })),
  setEnabled: vi.fn(async () => ({})),
  invokeContribution: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  hostClientApi: hostClientApiMock,
}));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => pluginControlApiMock,
}));

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: ({
    descriptor,
  }: {
    descriptor: { surfaceId: string; label: string };
  }) => <div data-testid="provisioner-surface">{descriptor.label}</div>,
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

const connectedHost = {
  id: 'current',
  origin: 'http://192.168.1.9:17891',
  host_id: 'host-b',
  name: 'Beta',
  last_connected_at: '2026-08-20T00:00:00Z',
  needs_token: false,
  has_credential: true,
  connected: true,
};

const otherHost = {
  id: 'other',
  origin: 'http://192.168.1.8:17891',
  host_id: 'host-a',
  name: 'Alpha',
  last_connected_at: '2026-08-01T00:00:00Z',
  needs_token: false,
  has_credential: true,
  connected: false,
};

const sshHost = {
  id: 'ssh-lab',
  origin: 'http://127.0.0.1:41234',
  host_id: 'host-ssh',
  name: 'Lab',
  last_connected_at: '2026-09-01T00:00:00Z',
  needs_token: false,
  has_credential: true,
  connected: false,
  provision_kind: 'ssh',
  provision: { host: '203.0.113.8', port: 22, user: 'root' },
};

describe('RemoteClientSettings', () => {
  beforeEach(() => {
    for (const fn of Object.values(hostClientApiMock)) {
      fn.mockReset();
    }
    pluginControlApiMock.catalog.mockResolvedValue({
      plugins: [],
      runtimes: [],
    });
    pluginControlApiMock.contributionCatalog.mockResolvedValue({
      generation: 0,
      items: [],
    });
    pluginControlApiMock.setEnabled.mockReset();
    pluginControlApiMock.invokeContribution.mockReset();
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: connectedHost,
      profiles: [connectedHost, otherHost],
    });
    hostClientApiMock.discover.mockResolvedValue([
      {
        origin: 'http://192.168.1.12:17891',
        host_id: 'host-c',
        name: 'Office',
        saved: false,
      },
    ]);
    hostClientApiMock.connect.mockResolvedValue({
      profile: { ...otherHost, connected: true },
      stopped_host: true,
    });
    hostClientApiMock.delete.mockResolvedValue(undefined);
    hostClientApiMock.hostUpdates.mockResolvedValue([]);
    hostClientApiMock.applyHostUpdate.mockResolvedValue({
      fromVersion: '0.2.0',
      toVersion: '0.2.1',
    });
  });

  it('lists a discovered Host and asks for a connection code on first connect', async () => {
    const user = userEvent.setup();
    render(<RemoteClientSettings />);

    expect(await screen.findByText('Office')).toBeVisible();
    expect(screen.getByRole('button', { name: '手动连接' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: '手动连接' })
    ).not.toBeInTheDocument();
    const lanRow = screen
      .getByText('Office')
      .closest('.settings-host-row') as HTMLElement;
    await user.click(within(lanRow).getByRole('button', { name: '连接' }));

    const codeField = await within(lanRow).findByPlaceholderText('8 位连接码');
    expect(codeField).toBeVisible();
    expect(hostClientApiMock.connect).not.toHaveBeenCalled();

    await user.type(codeField, 'K7M2NPQX');
    await user.click(
      within(lanRow).getAllByRole('button', { name: '连接' }).at(-1)!
    );

    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.12:17891',
        token: 'K7M2NPQX',
        profile_id: undefined,
      })
    );
  });

  it('pins the connected Host and offers switch on another saved Host', async () => {
    const user = userEvent.setup();
    render(<RemoteClientSettings />);

    const beta = await screen.findByText('Beta');
    const saved = screen
      .getByRole('heading', { name: '已保存 Host' })
      .closest('.settings-section') as HTMLElement;
    const names = within(saved)
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(names[0]).toContain('Beta');
    expect(names[0]).toContain('已连接');
    expect(
      within(beta.closest('.settings-host-row')!).queryByRole('button', {
        name: '连接',
      })
    ).toBeNull();
    await user.click(beta);
    expect(screen.getByRole('button', { name: '断开' })).toBeVisible();
    await user.click(beta);

    await user.click(screen.getByText('Alpha'));
    expect(
      await screen.findByRole('button', { name: '切换连接' })
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '切换连接' }));
    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.8:17891',
        token: undefined,
        profile_id: 'other',
      })
    );
  });

  it('connects a saved Host without a connection code when none is currently connected', async () => {
    const user = userEvent.setup();
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [{ ...otherHost, connected: false }],
    });
    render(<RemoteClientSettings />);

    const saved = (
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).closest('.settings-section') as HTMLElement;
    await user.click(await within(saved).findByText('Alpha'));
    await user.click(within(saved).getByRole('button', { name: '连接' }));
    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.8:17891',
        token: undefined,
        profile_id: 'other',
      })
    );
  });

  it('shows a saved Host in this window without enabling it after connect', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    vi.mocked(toast.success).mockClear();
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [{ ...otherHost, connected: false }],
    });
    hostClientApiMock.connect.mockResolvedValue({
      profile: { ...otherHost, connected: false },
      stopped_host: false,
    });
    render(<RemoteClientSettings />);

    const saved = (
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).closest('.settings-section') as HTMLElement;
    expect(within(saved).queryByText('已连接')).toBeNull();
    await user.click(await within(saved).findByText('Alpha'));
    await user.click(within(saved).getByRole('button', { name: '连接' }));
    await waitFor(() => expect(hostClientApiMock.connect).toHaveBeenCalled());
    expect(within(saved).queryByText('已连接')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps LAN scan and saved Hosts when a provisioner plugin is enabled', async () => {
    const user = userEvent.setup();
    pluginControlApiMock.catalog.mockResolvedValue({
      plugins: [
        {
          id: 'acme.tunnel',
          name: 'Acme Tunnel',
          version: '1.0.0',
          description: null,
          enabled: true,
          builtin: true,
          sourceKind: 'vibex',
          sourcePath: '/plugins/acme.tunnel',
          formats: ['vibex'],
          skills: [],
          runtimes: [],
          warnings: [],
        },
      ],
      runtimes: [],
    });
    pluginControlApiMock.contributionCatalog.mockResolvedValue({
      generation: 1,
      items: [
        {
          pluginId: 'acme.tunnel',
          id: 'ssh',
          kind: 'remote_provisioner',
          label: 'SSH',
          generation: 1,
          metadata: {
            provisionKind: 'ssh',
            handler: 'provision.ensure',
            timeoutSeconds: 300,
            icon: 'cloud',
          },
        },
        {
          pluginId: 'acme.tunnel',
          id: 'connect-panel',
          kind: 'app_surface',
          label: 'Acme Tunnel',
          generation: 1,
          metadata: {
            slot: 'plugin.detail.panel',
            handler: 'surface.createSession',
            appEntrypoint: 'app',
            allowedMethods: ['session.start'],
            minHeight: 640,
          },
        },
      ],
    });
    render(<RemoteClientSettings />);

    expect(
      await screen.findByRole('heading', { name: '局域网 Host' })
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: '已保存 Host' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'SSH' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Acme Tunnel' })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('provisioner-surface')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'SSH' }));
    expect(await screen.findByTestId('provisioner-surface')).toBeVisible();
    expect(screen.getByRole('heading', { name: '局域网 Host' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已保存 Host' })).toBeVisible();
  });

  it('reconnects a saved SSH Host through the provisioner tunnel', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    vi.mocked(toast.info).mockClear();
    pluginControlApiMock.catalog.mockResolvedValue({
      plugins: [
        {
          id: 'acme.tunnel',
          name: 'Acme Tunnel',
          version: '1.0.0',
          description: null,
          enabled: true,
          builtin: true,
          sourceKind: 'vibex',
          sourcePath: '/plugins/acme.tunnel',
          formats: ['vibex'],
          skills: [],
          runtimes: [],
          warnings: [],
        },
      ],
      runtimes: [],
    });
    pluginControlApiMock.contributionCatalog.mockResolvedValue({
      generation: 1,
      items: [
        {
          pluginId: 'acme.tunnel',
          id: 'ssh',
          kind: 'remote_provisioner',
          label: 'SSH',
          generation: 1,
          metadata: {
            provisionKind: 'ssh',
            handler: 'provision.ensure',
            timeoutSeconds: 300,
            icon: 'cloud',
          },
        },
        {
          pluginId: 'acme.tunnel',
          id: 'connect-panel',
          kind: 'app_surface',
          label: 'Acme Tunnel',
          generation: 1,
          metadata: {
            slot: 'plugin.detail.panel',
            handler: 'surface.createSession',
            appEntrypoint: 'app',
            allowedMethods: ['provision.ensure'],
            minHeight: 640,
          },
        },
      ],
    });
    pluginControlApiMock.invokeContribution.mockResolvedValue({
      origin: 'http://127.0.0.1:56001',
    });
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [sshHost],
    });
    render(<RemoteClientSettings />);
    const saved = (
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).closest('.settings-section') as HTMLElement;
    await user.click(await within(saved).findByText('Lab'));
    await user.click(within(saved).getByRole('button', { name: '连接' }));
    expect(toast.info).not.toHaveBeenCalledWith('正在重新连接远程服务');
    await waitFor(() =>
      expect(pluginControlApiMock.invokeContribution).toHaveBeenCalledWith(
        'acme.tunnel',
        'provision.ensure',
        {
          profile: {
            id: 'ssh-lab',
            origin: 'http://127.0.0.1:41234',
            name: 'Lab',
            provisionKind: 'ssh',
            provision: { host: '203.0.113.8', port: 22, user: 'root' },
            hasCredential: true,
          },
        },
        300
      )
    );
    await waitFor(() =>
      expect(hostClientApiMock.connect).toHaveBeenCalledWith({
        origin: 'http://127.0.0.1:56001',
        token: undefined,
        profile_id: 'ssh-lab',
      })
    );
  });

  it('does not connect a saved SSH Host when the provisioner is missing', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    hostClientApiMock.status.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [sshHost],
    });
    render(<RemoteClientSettings />);
    const saved = (
      await screen.findByRole('heading', { name: '已保存 Host' })
    ).closest('.settings-section') as HTMLElement;
    await user.click(await within(saved).findByText('Lab'));
    await user.click(within(saved).getByRole('button', { name: '连接' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '请先启用 SSH 再连接这台 Host。'
      )
    );
    expect(hostClientApiMock.connect).not.toHaveBeenCalled();
  });

  it('marks SSH-provisioned saved Hosts without treating them as the current connection', async () => {
    const user = userEvent.setup();
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: connectedHost,
      profiles: [connectedHost, sshHost],
    });
    render(<RemoteClientSettings />);

    const lab = await screen.findByText('Lab');
    expect(lab).toBeVisible();
    const labRow = lab.closest('.settings-host-row') as HTMLElement;
    expect(within(labRow).getByText('SSH')).toBeVisible();
    expect(within(labRow).queryByText('203.0.113.8:17891')).toBeNull();
    await user.click(lab);
    expect(within(labRow).queryByText('host-ssh')).toBeNull();
    expect(within(labRow).queryByText('203.0.113.8:17891')).toBeNull();
    await user.click(within(labRow).getByText('查看详细信息'));
    expect(within(labRow).getByText('203.0.113.8:17891')).toBeVisible();
    expect(within(labRow).getByText('host-ssh')).toBeVisible();
    expect(within(labRow).getByText('SSH 插件')).toBeVisible();
    expect(within(labRow).getByText('配置来源')).toBeVisible();
    expect(within(labRow).queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(
      within(
        screen.getByText('Beta').closest('.settings-host-row') as HTMLElement
      ).queryByText('SSH')
    ).toBeNull();
  });

  it('offers a Host-shell update when the saved Host is behind', async () => {
    const user = userEvent.setup();
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: connectedHost,
      profiles: [connectedHost, sshHost],
    });
    hostClientApiMock.hostUpdates.mockResolvedValue([
      {
        profile_id: 'ssh-lab',
        current_version: '0.2.0',
        latest_version: '0.2.1',
        update_available: true,
        reachable: true,
      },
    ]);
    render(<RemoteClientSettings />);
    const lab = await screen.findByText('Lab');
    const labRow = lab.closest('.settings-host-row') as HTMLElement;
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    await user.click(
      await within(labRow).findByRole('button', { name: '可更新' })
    );
    await waitFor(() =>
      expect(ConfirmDialog.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '请确认远程更新',
          message: expect.stringContaining('Lab'),
        })
      )
    );
    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('203.0.113.8:17891'),
      })
    );
    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/0\.2\.0.*0\.2\.1/),
      })
    );
    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('2 分钟'),
      })
    );
    await waitFor(() =>
      expect(hostClientApiMock.applyHostUpdate).toHaveBeenCalledWith('ssh-lab')
    );
  });

  it('shows the remote Host unreachable error when the update cannot connect', async () => {
    const user = userEvent.setup();
    const { toast } = await import('@/components/ui/toast');
    vi.mocked(toast.error).mockClear();
    hostClientApiMock.status.mockResolvedValue({
      connected: true,
      profile: connectedHost,
      profiles: [connectedHost, sshHost],
    });
    hostClientApiMock.hostUpdates.mockResolvedValue([
      {
        profile_id: 'ssh-lab',
        current_version: '0.2.0',
        latest_version: '0.2.1',
        update_available: true,
        reachable: true,
      },
    ]);
    hostClientApiMock.applyHostUpdate.mockRejectedValue(
      new Error('Bad request: host_update_unreachable')
    );
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    render(<RemoteClientSettings />);
    const lab = await screen.findByText('Lab');
    const labRow = lab.closest('.settings-host-row') as HTMLElement;
    await user.click(
      await within(labRow).findByRole('button', { name: '可更新' })
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '远程 Host 连接失败，更新错误，请检查远程服务状态'
      )
    );
  });
});
