import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopCapabilityError,
  desktopShellCall,
  isLocalDesktopHost,
  isTauriClient,
} from './desktopShell';
import { configureBackendTransport } from './backendTransport';
import { tauriBackendTransport } from './transport/tauriTransport';
import type { BackendTransport } from './transport';

const tauriInvoke = vi.fn();

vi.mock('@/lib/tauriApi', () => ({
  tauriInvoke: (...args: unknown[]) => tauriInvoke(...args),
}));

function transport(
  environment: BackendTransport['environment']
): BackendTransport {
  return {
    environment,
    call: vi.fn(),
  };
}

describe('desktop shell calls', () => {
  afterEach(() => {
    configureBackendTransport(tauriBackendTransport);
    tauriInvoke.mockReset();
  });

  it('treats only the local desktop host as Host-path OS integration', () => {
    expect(isLocalDesktopHost('desktop')).toBe(true);
    expect(isLocalDesktopHost('remote-desktop')).toBe(false);
    expect(isLocalDesktopHost('web')).toBe(false);
    expect(isTauriClient('desktop')).toBe(true);
    expect(isTauriClient('remote-desktop')).toBe(true);
    expect(isTauriClient('web')).toBe(false);
  });

  it('invokes local Tauri for desktop-shell commands', async () => {
    configureBackendTransport(transport('desktop'));
    tauriInvoke.mockResolvedValue(undefined);
    await expect(
      desktopShellCall('reveal_in_file_manager', { path: '/tmp/demo' })
    ).resolves.toBeUndefined();
    expect(tauriInvoke).toHaveBeenCalledWith('reveal_in_file_manager', {
      path: '/tmp/demo',
    });
  });

  it('keeps client chrome available on remote-desktop', async () => {
    configureBackendTransport(transport('remote-desktop'));
    tauriInvoke.mockResolvedValue(undefined);
    await desktopShellCall('update_tray_badge', { count: 2 });
    expect(tauriInvoke).toHaveBeenCalledWith('update_tray_badge', { count: 2 });
  });

  it('refuses desktop-shell commands in the web environment', async () => {
    configureBackendTransport(transport('web'));
    await expect(
      desktopShellCall('open_project_in_editor', { id: 'project-1' })
    ).rejects.toMatchObject({
      name: 'DesktopCapabilityError',
      code: 'capability_unavailable',
    });
    expect(tauriInvoke).not.toHaveBeenCalled();
    await expect(
      desktopShellCall('open_project_in_editor', { id: 'project-1' })
    ).rejects.toBeInstanceOf(DesktopCapabilityError);
  });
});
