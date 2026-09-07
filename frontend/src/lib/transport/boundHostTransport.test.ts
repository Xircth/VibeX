import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundHostTransport } from './boundHostTransport';
import type { RemoteDesktopTransport } from './remoteDesktopTransport';
import { TauriTransport, tauriBackendTransport } from './tauriTransport';

describe('BoundHostTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Host product commands to the bound Server and keeps shell commands local', async () => {
    const remote = {
      call: vi.fn(async (command: string) => `remote:${command}`),
    } as unknown as RemoteDesktopTransport;
    const localCall = vi
      .spyOn(tauriBackendTransport, 'call')
      .mockImplementation(async (command: string) => `local:${command}`);
    const transport = new BoundHostTransport(remote);

    expect(transport.environment).toBe('remote-desktop');
    await expect(transport.call('get_projects')).resolves.toBe(
      'remote:get_projects'
    );
    await expect(transport.call('list_directory')).resolves.toBe(
      'remote:list_directory'
    );
    await expect(transport.call('get_user_system_info')).resolves.toBe(
      'remote:get_user_system_info'
    );
    await expect(transport.call('plugin_control_catalog')).resolves.toBe(
      'remote:plugin_control_catalog'
    );
    await expect(transport.call('host_client_status')).resolves.toBe(
      'local:host_client_status'
    );
    expect(remote.call).toHaveBeenCalledWith(
      'get_projects',
      undefined,
      undefined
    );
    expect(localCall).toHaveBeenCalledWith(
      'host_client_status',
      undefined,
      undefined
    );
  });

  it('listens for Host product events only on the bound Server', async () => {
    const remoteUnlisten = vi.fn();
    const localUnlisten = vi.fn();
    const remote = {
      call: vi.fn(),
      listen: vi.fn(async () => remoteUnlisten),
    } as unknown as RemoteDesktopTransport;
    const localListen = vi
      .spyOn(tauriBackendTransport as TauriTransport, 'listen')
      .mockResolvedValue(localUnlisten);
    const transport = new BoundHostTransport(remote);
    const handler = vi.fn();

    const stopHost = await transport.listen('agent-management-event', handler);
    expect(remote.listen).toHaveBeenCalledWith(
      'agent-management-event',
      handler
    );
    expect(localListen).not.toHaveBeenCalled();
    stopHost();
    expect(remoteUnlisten).toHaveBeenCalledOnce();

    const stopShell = await transport.listen('host-client-changed', handler);
    expect(localListen).toHaveBeenCalledWith('host-client-changed', handler);
    stopShell();
    expect(localUnlisten).toHaveBeenCalledOnce();
  });
});
