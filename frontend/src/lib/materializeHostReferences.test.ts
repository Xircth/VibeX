import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hostReferenceCatalog } from './materializeHostReferences';

const hostClientApi = vi.hoisted(() => ({
  status: vi.fn(),
}));
const backendCall = vi.hoisted(() => vi.fn());
const isTauriClient = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/api', () => ({
  hostClientApi,
}));
vi.mock('@/lib/backendTransport', () => ({
  backendCall,
}));
vi.mock('@/lib/desktopShell', () => ({
  isTauriClient,
}));

describe('hostReferenceCatalog', () => {
  it('lists saved SSH Hosts except the connected one', () => {
    const entries = hostReferenceCatalog(
      [
        {
          id: 'ssh-lab',
          origin: 'http://127.0.0.1:1',
          host_id: null,
          name: 'Lab',
          last_connected_at: null,
          needs_token: false,
          has_credential: true,
          connected: true,
          provision_kind: 'ssh',
          provision: { host: '203.0.113.8', port: 22, user: 'root' },
        },
        {
          id: 'ssh-edge',
          origin: 'http://127.0.0.1:2',
          host_id: null,
          name: 'Edge',
          last_connected_at: null,
          needs_token: false,
          has_credential: true,
          connected: false,
          provision_kind: 'ssh',
          provision: { host: '198.51.100.8', port: 22, user: 'deploy' },
        },
      ],
      { connectedProfileId: 'ssh-lab' }
    );
    expect(entries.map((entry) => entry.label)).toEqual(['Edge']);
    expect(entries[0]?.content).toContain('HostName 198.51.100.8');
    expect(entries[0]?.content).not.toContain('password');
  });

  it('adds the local workstation when requested', () => {
    const entries = hostReferenceCatalog([], {
      includeLocal: true,
      local: { user: 'mac', host: 'studio.local', port: 22 },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fileName).toBe('local.sshconfig');
    expect(entries[0]?.content).toContain('HostName studio.local');
  });
});

describe('materializeMentionedHostFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriClient.mockReturnValue(true);
    hostClientApi.status.mockResolvedValue({
      connected: true,
      profile: { id: 'ssh-lab' },
      local_ssh: { user: 'mac', host: 'studio.local', port: 22 },
      profiles: [
        {
          id: 'ssh-edge',
          origin: 'http://127.0.0.1:2',
          host_id: null,
          name: 'Edge',
          last_connected_at: null,
          needs_token: false,
          has_credential: true,
          connected: false,
          provision_kind: 'ssh',
          provision: { host: '198.51.100.8', port: 22, user: 'deploy' },
        },
      ],
    });
    backendCall.mockResolvedValue({
      files: [
        {
          fileName: 'edge-sshedge.sshconfig',
          path: '/home/u/.vibex/ssh-hosts/edge-sshedge.sshconfig',
        },
        {
          fileName: 'local.sshconfig',
          path: '/home/u/.vibex/ssh-hosts/local.sshconfig',
        },
      ],
    });
  });

  it('writes mentioned Host files into the Host user directory', async () => {
    const { materializeMentionedHostFiles } = await import(
      './materializeHostReferences'
    );
    await expect(
      materializeMentionedHostFiles({
        text: 'deploy [@:Edge](.vibex/ssh-hosts/edge-sshedge.sshconfig) [@:local](.vibex/ssh-hosts/local.sshconfig)',
      })
    ).resolves.toBe(
      'deploy [@:Edge](/home/u/.vibex/ssh-hosts/edge-sshedge.sshconfig) [@:local](/home/u/.vibex/ssh-hosts/local.sshconfig)'
    );
    expect(backendCall).toHaveBeenCalledWith('write_ssh_host_files', {
      files: [
        {
          fileName: 'edge-sshedge.sshconfig',
          content: expect.stringContaining('HostName 198.51.100.8'),
        },
        {
          fileName: 'local.sshconfig',
          content: expect.stringContaining('HostName studio.local'),
        },
      ],
    });
  });
});
