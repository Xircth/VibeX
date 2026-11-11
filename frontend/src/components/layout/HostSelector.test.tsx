import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Scope } from '@/keyboard';
import { HostSelector } from './HostSelector';

const mocks = vi.hoisted(() => ({
  isTauri: true,
  status: vi.fn(),
  discover: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  openSettingsSurface: vi.fn(),
  catalog: vi.fn(),
  contributionCatalog: vi.fn(),
  setEnabled: vi.fn(),
  invokeContribution: vi.fn(),
  hostCall: vi.fn(),
}));

vi.mock('@/lib/desktopShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/desktopShell')>();
  return {
    ...actual,
    isTauriClient: () => mocks.isTauri,
  };
});

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock('@/lib/api', () => ({
  hostClientApi: {
    status: (...args: unknown[]) => mocks.status(...args),
    discover: (...args: unknown[]) => mocks.discover(...args),
    connect: (...args: unknown[]) => mocks.connect(...args),
    disconnect: (...args: unknown[]) => mocks.disconnect(...args),
  },
  openSettingsSurface: (...args: unknown[]) =>
    mocks.openSettingsSurface(...args),
}));

vi.mock('@/lib/api/plugins', () => ({
  createPluginControlApi: () => ({
    catalog: (...args: unknown[]) => mocks.catalog(...args),
    contributionCatalog: (...args: unknown[]) =>
      mocks.contributionCatalog(...args),
    setEnabled: (...args: unknown[]) => mocks.setEnabled(...args),
    invokeContribution: (...args: unknown[]) =>
      mocks.invokeContribution(...args),
    hostCall: (...args: unknown[]) => mocks.hostCall(...args),
  }),
}));

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: ({
    descriptor,
  }: {
    descriptor: { pluginId: string; surfaceId: string };
  }) => (
    <div
      data-testid="mock-ssh-app-surface"
      data-plugin-id={descriptor.pluginId}
      data-surface-id={descriptor.surfaceId}
    />
  ),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
  useRevealAfterOverlayReady: () => true,
}));

function renderHostSelector() {
  return render(
    <MemoryRouter>
      <HotkeysProvider initiallyActiveScopes={[Scope.GLOBAL]}>
        <HostSelector />
      </HotkeysProvider>
    </MemoryRouter>
  );
}

describe('HostSelector', () => {
  beforeEach(() => {
    mocks.isTauri = true;
    mocks.status.mockReset();
    mocks.discover.mockReset();
    mocks.connect.mockReset();
    mocks.disconnect.mockReset();
    mocks.openSettingsSurface.mockReset();
    mocks.catalog.mockReset();
    mocks.contributionCatalog.mockReset();
    mocks.setEnabled.mockReset();
    mocks.invokeContribution.mockReset();
    mocks.hostCall.mockReset();
    mocks.hostCall.mockResolvedValue({});

    mocks.status.mockResolvedValue({ profiles: [] });
    mocks.discover.mockResolvedValue([
      {
        host_id: 'lan-mac',
        name: 'macdeMacBook-Air.local',
        origin: 'http://192.168.31.102:17891',
      },
    ]);
    mocks.catalog.mockResolvedValue({
      plugins: [
        {
          id: 'vibex.remote-ssh',
          name: 'Remote SSH',
          enabled: true,
          generation: 1,
        },
      ],
    });
    mocks.contributionCatalog.mockResolvedValue({
      items: [
        {
          pluginId: 'vibex.remote-ssh',
          id: 'ssh',
          kind: 'remote_provisioner',
          label: 'SSH',
          metadata: {
            provisionKind: 'ssh',
            handler: 'provision.ensure',
            timeoutSeconds: 300,
          },
        },
        {
          pluginId: 'vibex.remote-ssh',
          id: 'connect-panel',
          kind: 'app_surface',
          label: 'Remote SSH',
          metadata: {
            slot: 'plugin.detail.panel',
            handler: 'surface.createSession',
            appEntrypoint: 'app',
            allowedMethods: ['session.start'],
          },
        },
      ],
    });
  });

  it('places the 3 host quick actions at the top and renders a Local badge without daemon copy', async () => {
    const user = userEvent.setup();
    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));

    const popover = await screen.findByTestId('host-selector-popover');
    const actionsBar = within(popover).getByTestId('host-selector-actions');

    expect(popover.firstElementChild).toBe(actionsBar);
    expect(actionsBar.className).toContain('border-b');

    expect(
      within(actionsBar).getByTestId('host-selector-connect-host')
    ).toBeInTheDocument();
    expect(
      within(actionsBar).getByTestId('host-selector-new-ssh-host')
    ).toBeInTheDocument();
    expect(
      within(actionsBar).getByTestId('host-selector-manage-remote')
    ).toBeInTheDocument();

    const localItem = within(popover).getByTestId('host-selector-item-local');
    expect(within(localItem).getByText('Local Host')).toBeInTheDocument();
    expect(
      within(localItem).getByTestId('host-selector-local-badge')
    ).toBeInTheDocument();
    expect(within(localItem).getByText('127.0.0.1')).toBeInTheDocument();
    expect(popover.textContent).not.toContain('本机守护进程');
    expect(popover.textContent).not.toContain('管理远程主机连接');
  });

  it('opens the Connect Host dialog and connects via hostClientApi', async () => {
    const user = userEvent.setup();
    mocks.connect.mockResolvedValue({
      profile: {
        id: 'p-1',
        name: 'Office Mac',
        origin: 'http://192.168.1.20:17891',
        connected: true,
        has_credential: true,
      },
      stopped_host: false,
    });

    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));
    await user.click(
      await screen.findByTestId('host-selector-connect-host')
    );

    const dialog = await screen.findByTestId('connect-host-dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    await user.type(inputs[0]!, 'http://192.168.1.20:17891');
    await user.type(inputs[1]!, 'ABCD1234');

    const submitButton = dialog.querySelector(
      'button[data-dialog-primary="true"]'
    ) as HTMLButtonElement;
    await user.click(submitButton);

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        origin: 'http://192.168.1.20:17891',
        token: 'ABCD1234',
        profile_id: undefined,
      });
    });
  });

  it('connects synced HTTP hosts directly without asking for a code and prefills ConnectHostDialog if needs_token', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue({
      profiles: [
        {
          id: 'p-http-synced',
          name: 'Studio Mini',
          origin: 'http://192.168.1.50:17891',
          connected: false,
          has_credential: true,
          needs_token: false,
        },
        {
          id: 'p-http-revoked',
          name: 'Revoked Studio',
          origin: 'http://192.168.1.60:17891',
          connected: false,
          has_credential: false,
          needs_token: true,
        },
      ],
    });
    mocks.connect.mockResolvedValue({
      profile: {
        id: 'p-http-synced',
        name: 'Studio Mini',
        origin: 'http://192.168.1.50:17891',
        connected: true,
        has_credential: true,
      },
      stopped_host: false,
    });

    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));
    await user.click(
      await screen.findByTestId('host-selector-item-p-http-synced')
    );

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        profile_id: 'p-http-synced',
        origin: 'http://192.168.1.50:17891',
      });
    });
    expect(screen.queryByTestId('connect-host-dialog')).not.toBeInTheDocument();

    // Clicking the revoked profile opens ConnectHostDialog prefilled with origin & profileId
    await user.click(screen.getByTestId('toolbar-host-selector'));
    await user.click(
      await screen.findByTestId('host-selector-item-p-http-revoked')
    );

    const dialog = await screen.findByTestId('connect-host-dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    expect((inputs[0] as HTMLInputElement).value).toBe(
      'http://192.168.1.60:17891'
    );

    await user.type(inputs[1]!, 'NEWCODE8');
    const submitButton = dialog.querySelector(
      'button[data-dialog-primary="true"]'
    ) as HTMLButtonElement;
    await user.click(submitButton);

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenLastCalledWith({
        origin: 'http://192.168.1.60:17891',
        token: 'NEWCODE8',
        profile_id: 'p-http-revoked',
      });
    });
  });

  it('renders durable SSH address and prefills SSH settings into NewSshHostDialog when SSH login fails on a new device', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue({
      profiles: [
        {
          id: 'p-ssh-synced',
          name: 'Prod GPU Box',
          origin: 'http://127.0.0.1:54321',
          connected: false,
          has_credential: true,
          provision_kind: 'ssh',
          provision: {
            host: '10.0.0.8',
            port: 2222,
            user: 'ubuntu',
            jump: 'bastion.internal',
            remotePort: 17891,
          },
        },
      ],
    });
    mocks.invokeContribution.mockRejectedValue(
      new Error('Permission denied (publickey,password)')
    );

    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));
    const sshItem = await screen.findByTestId('host-selector-item-p-ssh-synced');
    expect(sshItem.textContent).toContain('10.0.0.8:17891');
    expect(sshItem.textContent).not.toContain('127.0.0.1:54321');

    await user.click(sshItem);

    await waitFor(() => {
      expect(mocks.hostCall).toHaveBeenCalledWith(
        'vibex.remote-ssh',
        'storage',
        'settings.put',
        {
          name: 'Prod GPU Box',
          host: '10.0.0.8',
          port: 2222,
          user: 'ubuntu',
          jump: 'bastion.internal',
          dataDir: '',
        }
      );
    });

    const dialog = await screen.findByTestId('new-ssh-host-dialog');
    expect(
      await within(dialog).findByTestId('mock-ssh-app-surface')
    ).toBeInTheDocument();
  });

  it('opens the New SSH Host dialog and mounts the SSH provisioner surface', async () => {
    const user = userEvent.setup();
    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));
    await user.click(
      await screen.findByTestId('host-selector-new-ssh-host')
    );

    const dialog = await screen.findByTestId('new-ssh-host-dialog');
    const surface = await within(dialog).findByTestId('mock-ssh-app-surface');
    expect(surface).toHaveAttribute('data-plugin-id', 'vibex.remote-ssh');
    expect(surface).toHaveAttribute('data-surface-id', 'connect-panel');
  });

  it('opens the Remote Connection settings client tab when clicking Manage Remote Connections', async () => {
    const user = userEvent.setup();
    renderHostSelector();

    await user.click(screen.getByTestId('toolbar-host-selector'));
    await user.click(
      await screen.findByTestId('host-selector-manage-remote')
    );

    expect(mocks.openSettingsSurface).toHaveBeenCalledWith(
      expect.any(Function),
      '/settings/web-service?role=client'
    );
  });
});
