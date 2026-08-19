import { describe, expect, it } from 'vitest';

import { resolveAppUpdate } from './resolve';

describe('resolveAppUpdate', () => {
  it('prefers GitHub release notes when the signed feed only has a placeholder', async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion: async () => '0.1.2',
      checkSignedFeed: async () => ({
        version: '0.1.3',
        body: 'Desktop installers for v0.1.3.',
        date: '2026-08-16T12:00:00.000Z',
      }),
      checkGitHubRelease: async () => ({
        current_version: '0.1.2',
        latest_version: '0.1.3',
        update_available: true,
        release_url: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        repository: 'Xircth/VibeX',
        checked: true,
        error: null,
        body: '## English\n\nReal notes\n\n## 中文\n\n真正的说明',
        published_at: '2026-08-16T00:00:00Z',
        checked_at: '2026-08-18T01:00:00Z',
      }),
      now: () => 1_700_000_000_000,
    });

    expect(snapshot).toEqual({
      currentVersion: '0.1.2',
      lastCheckedAt: 1_700_000_000_000,
      checked: true,
      error: null,
      update: {
        version: '0.1.3',
        body: '## English\n\nReal notes\n\n## 中文\n\n真正的说明',
        date: '2026-08-16T12:00:00.000Z',
        releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        canInstall: true,
      },
    });
  });

  it('keeps a GitHub-only update as viewable when the signed feed has nothing', async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion: async () => '0.1.2',
      checkSignedFeed: async () => null,
      checkGitHubRelease: async () => ({
        current_version: '0.1.2',
        latest_version: '0.1.3',
        update_available: true,
        release_url: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        repository: 'Xircth/VibeX',
        checked: true,
        error: null,
        body: 'Release notes',
        published_at: '2026-08-16T00:00:00Z',
        checked_at: '2026-08-18T01:00:00Z',
      }),
      now: () => 1_700_000_000_000,
    });

    expect(snapshot.update).toEqual({
      version: '0.1.3',
      body: 'Release notes',
      date: '2026-08-16T00:00:00Z',
      releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
      canInstall: false,
    });
  });

  it('records an up-to-date result with the check time', async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion: async () => '0.1.3',
      checkSignedFeed: async () => null,
      checkGitHubRelease: async () => ({
        current_version: '0.1.3',
        latest_version: '0.1.3',
        update_available: false,
        release_url: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        repository: 'Xircth/VibeX',
        checked: true,
        error: null,
        body: 'Already shipped notes',
        published_at: '2026-08-16T00:00:00Z',
        checked_at: '2026-08-18T01:00:00Z',
      }),
      now: () => 1_700_000_000_000,
    });

    expect(snapshot.update).toBeNull();
    expect(snapshot.lastCheckedAt).toBe(1_700_000_000_000);
    expect(snapshot.checked).toBe(true);
  });

  it('surfaces a check error when both sources fail', async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion: async () => '0.1.2',
      checkSignedFeed: async () => {
        throw new Error('signed feed timed out');
      },
      checkGitHubRelease: async () => ({
        current_version: '0.1.2',
        latest_version: null,
        update_available: false,
        release_url: null,
        repository: 'Xircth/VibeX',
        checked: false,
        error: 'GitHub release check returned 403',
        body: null,
        published_at: null,
        checked_at: '2026-08-18T01:00:00Z',
      }),
      now: () => 1_700_000_000_000,
    });

    expect(snapshot.update).toBeNull();
    expect(snapshot.checked).toBe(false);
    expect(snapshot.error).toContain('403');
  });
});
