import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBackendTransport } from '@/lib/transport';

const hostClientStatus = vi.hoisted(() => vi.fn());
const tauriListen = vi.hoisted(() => vi.fn(async () => () => undefined));
const getCurrentWindow = vi.hoisted(() => vi.fn(() => ({ label: 'main' })));
const isTauriRuntime = vi.hoisted(() => vi.fn(() => true));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

vi.mock('./WebTransportBootstrap', () => ({
  isTauriRuntime,
}));

vi.mock('@/lib/api', () => ({
  hostClientApi: {
    status: hostClientStatus,
    connect: vi.fn(),
  },
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriListen,
}));

import { RemoteDesktopTransport } from '@/lib/transport';
import { DesktopHostBootstrap } from './DesktopHostBootstrap';

function Probe() {
  const transport = useBackendTransport();
  return <div>env:{transport.environment}</div>;
}

function renderBootstrap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DesktopHostBootstrap>
        <Probe />
      </DesktopHostBootstrap>
    </QueryClientProvider>
  );
}

describe('DesktopHostBootstrap', () => {
  afterEach(() => {
    vi.clearAllMocks();
    getCurrentWindow.mockReturnValue({ label: 'main' });
    isTauriRuntime.mockReturnValue(true);
    tauriListen.mockResolvedValue(() => undefined);
  });

  it('keeps the main window on the local Host after a remote window is opened', async () => {
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: true,
      profile: { origin: 'http://127.0.0.1:61091' },
      profiles: [
        {
          id: 'ssh-1',
          origin: 'http://127.0.0.1:61091',
          connected: true,
        },
      ],
    });
    renderBootstrap();
    expect(await screen.findByText('env:desktop')).toBeInTheDocument();
    await waitFor(() => {
      expect(hostClientStatus).toHaveBeenCalled();
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps extra local App windows on the local Host', async () => {
    getCurrentWindow.mockReturnValue({ label: 'app-local-1' });
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: true,
      profile: { origin: 'http://127.0.0.1:61091' },
      profiles: [],
    });
    renderBootstrap();
    expect(await screen.findByText('env:desktop')).toBeInTheDocument();
    await waitFor(() => {
      expect(hostClientStatus).toHaveBeenCalled();
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps the settings window on the local Host', async () => {
    getCurrentWindow.mockReturnValue({ label: 'settings' });
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [
        {
          id: 'ssh-1',
          origin: 'http://127.0.0.1:61091',
          connected: false,
        },
      ],
    });
    renderBootstrap();
    expect(await screen.findByText('env:desktop')).toBeInTheDocument();
    await waitFor(() => {
      expect(hostClientStatus).toHaveBeenCalled();
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it('binds the Host window Settings companion to the same Host', async () => {
    getCurrentWindow.mockReturnValue({ label: 'settings-host-ssh-1' });
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: true,
      profile: { origin: 'http://127.0.0.1:61091' },
      profiles: [],
    });
    renderBootstrap();
    expect(await screen.findByText('env:remote-desktop')).toBeInTheDocument();
    expect(attach).toHaveBeenCalledWith({
      profileId: 'active-host-client',
      baseUrl: 'http://127.0.0.1:61091',
    });
  });

  it('binds only the Host window to the connected Host', async () => {
    getCurrentWindow.mockReturnValue({ label: 'host-ssh-1' });
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: true,
      profile: { origin: 'http://127.0.0.1:61091' },
      profiles: [],
    });
    renderBootstrap();
    expect(await screen.findByText('env:remote-desktop')).toBeInTheDocument();
    expect(attach).toHaveBeenCalledWith({
      profileId: 'active-host-client',
      baseUrl: 'http://127.0.0.1:61091',
    });
  });

  it('stays on the local Host when nothing is connected', async () => {
    const attach = vi.spyOn(RemoteDesktopTransport, 'attach');
    hostClientStatus.mockResolvedValue({
      connected: false,
      profile: null,
      profiles: [],
    });
    renderBootstrap();
    expect(await screen.findByText('env:desktop')).toBeInTheDocument();
    await waitFor(() => {
      expect(hostClientStatus).toHaveBeenCalled();
    });
    expect(attach).not.toHaveBeenCalled();
  });
});
