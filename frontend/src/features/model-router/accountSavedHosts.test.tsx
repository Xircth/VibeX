import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncableHostProfile } from '@/lib/api';

import type { RouterOverview } from './account';
import {
  AccountSavedHostsSyncBridge,
  isolateSavedHostsOnSignOut,
  pushLocalSavedHostChanges,
  resetAccountSavedHostsForTests,
  summarizeSyncableHostProfile,
  syncAccountSavedHosts,
} from './accountSavedHosts';

const mocks = vi.hoisted(() => ({
  isTauri: true,
  windowLabel: 'main',
  accountState: {
    isSignedIn: false,
    user: null as RouterOverview['user'] | null,
  },
  listeners: new Set<() => void>(),
  status: vi.fn(),
  setSyncAccount: vi.fn(),
  exportSyncProfiles: vi.fn(),
  mergeSyncProfiles: vi.fn(),
  markSyncPushed: vi.fn(),
  ackSyncDeletes: vi.fn(),
  listSavedHosts: vi.fn(),
  putSavedHosts: vi.fn(),
  deleteSavedHost: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel }),
}));

vi.mock('@/lib/desktopShell', () => ({
  isTauriClient: () => mocks.isTauri,
}));

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn((event: string, handler: () => void) => {
      if (event === 'host-client-changed') {
        mocks.listeners.add(handler);
        return Promise.resolve(() => {
          mocks.listeners.delete(handler);
        });
      }
      return Promise.resolve(() => undefined);
    }),
  };
});

vi.mock('@/lib/api', () => ({
  hostClientApi: {
    status: (...args: unknown[]) => mocks.status(...args),
    setSyncAccount: (...args: unknown[]) => mocks.setSyncAccount(...args),
    exportSyncProfiles: (...args: unknown[]) =>
      mocks.exportSyncProfiles(...args),
    mergeSyncProfiles: (...args: unknown[]) => mocks.mergeSyncProfiles(...args),
    markSyncPushed: (...args: unknown[]) => mocks.markSyncPushed(...args),
    ackSyncDeletes: (...args: unknown[]) => mocks.ackSyncDeletes(...args),
  },
}));

vi.mock('./account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./account')>();
  return {
    ...actual,
    accountApi: {
      ...actual.accountApi,
      listSavedHosts: (...args: unknown[]) => mocks.listSavedHosts(...args),
      putSavedHosts: (...args: unknown[]) => mocks.putSavedHosts(...args),
      deleteSavedHost: (...args: unknown[]) => mocks.deleteSavedHost(...args),
    },
  };
});

vi.mock('./useVibeXAccount', () => ({
  useVibeXAccount: () => mocks.accountState,
}));

const userA: NonNullable<RouterOverview['user']> = {
  displayName: 'Alice',
  username: 'alice',
  email: 'alice@vibex.dev',
};

const userB: NonNullable<RouterOverview['user']> = {
  displayName: 'Bob',
  username: 'bob',
  email: 'bob@vibex.dev',
};

describe('accountSavedHosts', () => {
  beforeEach(() => {
    resetAccountSavedHostsForTests();
    mocks.isTauri = true;
    mocks.windowLabel = 'main';
    mocks.accountState = { isSignedIn: false, user: null };
    mocks.listeners.clear();

    mocks.status.mockReset();
    mocks.setSyncAccount.mockReset();
    mocks.exportSyncProfiles.mockReset();
    mocks.mergeSyncProfiles.mockReset();
    mocks.markSyncPushed.mockReset();
    mocks.ackSyncDeletes.mockReset();
    mocks.listSavedHosts.mockReset();
    mocks.putSavedHosts.mockReset();
    mocks.deleteSavedHost.mockReset();

    mocks.status.mockResolvedValue({ profiles: [] });
    mocks.setSyncAccount.mockResolvedValue({ profiles: [] });
    mocks.exportSyncProfiles.mockResolvedValue({
      profiles: [],
      pendingDeletes: [],
    });
    mocks.mergeSyncProfiles.mockResolvedValue({ profiles: [] });
    mocks.markSyncPushed.mockResolvedValue(undefined);
    mocks.ackSyncDeletes.mockResolvedValue(undefined);
    mocks.listSavedHosts.mockResolvedValue({ savedHosts: [] });
    mocks.putSavedHosts.mockResolvedValue({ savedHosts: [] });
    mocks.deleteSavedHost.mockResolvedValue({ deleted: 1 });
  });

  it('flushes pending cloud deletes before pulling, merges authoritatively, pushes local changes, and strips secrets from UI summaries', async () => {
    const callOrder: string[] = [];

    mocks.setSyncAccount.mockImplementation(async () => {
      callOrder.push('setSyncAccount');
      return { profiles: [] };
    });

    const syncedRemoteSsh: SyncableHostProfile = {
      syncKey: 'ssh:ubuntu@10.0.0.8:22',
      profileId: 'p-ssh-1',
      hostId: 'host-ssh-1',
      name: 'GPU Server',
      origin: 'http://10.0.0.8:17891',
      provisionKind: 'ssh',
      provision: {
        host: '10.0.0.8',
        port: 22,
        user: 'ubuntu',
        remotePort: 17891,
      },
      credential: {
        deviceId: 'dev-synced',
        accessToken: 'vbx_super_secret_token',
      },
      lastConnectedAt: '2026-11-11T10:00:00Z',
    };

    const localHttpProfile: SyncableHostProfile = {
      profileId: 'p-http-local',
      hostId: 'host-http-local',
      name: 'Office Mac',
      origin: 'http://192.168.1.25:17891',
      credential: {
        deviceId: 'dev-local',
        accessToken: 'vbx_local_token',
      },
      lastConnectedAt: '2026-11-11T11:00:00Z',
    };

    mocks.exportSyncProfiles
      .mockImplementationOnce(async () => {
        callOrder.push('exportInitial');
        return {
          profiles: [localHttpProfile],
          pendingDeletes: [
            {
              id: 'del-1',
              profileId: 'p-deleted',
              hostId: 'host-deleted',
              origin: 'http://192.168.1.99:17891',
              deletedAt: '2026-11-11T09:00:00Z',
            },
          ],
        };
      })
      .mockImplementationOnce(async () => {
        callOrder.push('exportPostMerge');
        return {
          profiles: [syncedRemoteSsh, localHttpProfile],
          pendingDeletes: [],
        };
      });

    mocks.deleteSavedHost.mockImplementation(async () => {
      callOrder.push('deleteSavedHost');
      return { deleted: 1 };
    });
    mocks.ackSyncDeletes.mockImplementation(async () => {
      callOrder.push('ackSyncDeletes');
    });
    mocks.listSavedHosts.mockImplementation(async () => {
      callOrder.push('listSavedHosts');
      return { savedHosts: [syncedRemoteSsh] };
    });
    mocks.mergeSyncProfiles.mockImplementation(async () => {
      callOrder.push('mergeSyncProfiles');
      return { profiles: [] };
    });
    mocks.putSavedHosts.mockImplementation(async () => {
      callOrder.push('putSavedHosts');
      return { savedHosts: [syncedRemoteSsh, localHttpProfile] };
    });
    mocks.markSyncPushed.mockImplementation(async () => {
      callOrder.push('markSyncPushed');
    });
    mocks.status.mockResolvedValue({
      profiles: [
        {
          id: 'p-ssh-1',
          name: 'GPU Server',
          origin: 'http://10.0.0.8:17891',
          connected: false,
          has_credential: true,
          provision_kind: 'ssh',
          provision: { host: '10.0.0.8', port: 22, user: 'ubuntu' },
        },
        {
          id: 'p-http-local',
          name: 'Office Mac',
          origin: 'http://192.168.1.25:17891',
          connected: true,
          has_credential: true,
        },
      ],
    });

    const summaries = await syncAccountSavedHosts(userA);

    expect(callOrder).toEqual([
      'setSyncAccount',
      'exportInitial',
      'deleteSavedHost',
      'ackSyncDeletes',
      'listSavedHosts',
      'mergeSyncProfiles',
      'exportPostMerge',
      'putSavedHosts',
      'markSyncPushed',
    ]);
    expect(mocks.deleteSavedHost).toHaveBeenCalledWith({
      profileId: 'p-deleted',
      hostId: 'host-deleted',
      origin: 'http://192.168.1.99:17891',
      sshTarget: undefined,
    });
    expect(mocks.ackSyncDeletes).toHaveBeenCalledWith(['del-1']);
    expect(mocks.mergeSyncProfiles).toHaveBeenCalledWith({
      accountUserId: 'alice',
      profiles: [syncedRemoteSsh],
      authoritative: true,
    });
    expect(mocks.markSyncPushed).toHaveBeenCalledWith('alice', [
      'p-ssh-1',
      'p-http-local',
    ]);

    // Summaries never leak raw tokens or device IDs
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain('vbx_super_secret_token');
    expect(serialized).not.toContain('vbx_local_token');
    expect(serialized).not.toContain('dev-synced');
    expect(
      JSON.stringify(summarizeSyncableHostProfile(syncedRemoteSsh))
    ).not.toContain('vbx_super_secret_token');
  });

  it('pushes local saved-host deletions and edits to cloud', async () => {
    mocks.exportSyncProfiles.mockResolvedValue({
      profiles: [],
      pendingDeletes: [
        {
          id: 'del-ssh-1',
          profileId: 'p-ssh-1',
          hostId: 'host-ssh-1',
          sshTarget: 'ubuntu@10.0.0.8:22',
          deletedAt: '2026-11-11T12:00:00Z',
        },
      ],
    });

    await pushLocalSavedHostChanges(userA);

    expect(mocks.deleteSavedHost).toHaveBeenCalledWith({
      profileId: 'p-ssh-1',
      hostId: 'host-ssh-1',
      origin: undefined,
      sshTarget: 'ubuntu@10.0.0.8:22',
    });
    expect(mocks.ackSyncDeletes).toHaveBeenCalledWith(['del-ssh-1']);
    expect(mocks.putSavedHosts).not.toHaveBeenCalled();
  });

  it('isolates saved remote hosts on sign-out and when switching between Account A and Account B', async () => {
    mocks.accountState = { isSignedIn: true, user: userA };
    const { rerender } = render(<AccountSavedHostsSyncBridge />);

    await waitFor(() => {
      expect(mocks.setSyncAccount).toHaveBeenCalledWith('alice');
    });

    // Switch directly to Account B
    mocks.accountState = { isSignedIn: true, user: userB };
    rerender(<AccountSavedHostsSyncBridge />);

    await waitFor(() => {
      expect(mocks.setSyncAccount).toHaveBeenCalledWith('bob');
    });

    // Sign out
    mocks.accountState = { isSignedIn: false, user: null };
    rerender(<AccountSavedHostsSyncBridge />);

    await waitFor(() => {
      expect(mocks.setSyncAccount).toHaveBeenLastCalledWith(null);
    });

    // Explicit helper also isolates when called directly
    mocks.setSyncAccount.mockClear();
    await act(async () => {
      await isolateSavedHostsOnSignOut();
    });
    expect(mocks.setSyncAccount).toHaveBeenCalledWith(null);
  });
});
