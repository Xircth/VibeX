import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLastCheck,
  consumePostUpdateRestoreRoute,
  readDismissedVersion,
  readLastCheck,
  readLastMainWindowRoute,
  recordMainWindowRoute,
  writeDismissedVersion,
  writeLastCheck,
  writePostUpdateRestoreRoute,
} from './storage';

describe('app update check storage', () => {
  afterEach(() => {
    clearLastCheck();
    writeDismissedVersion(null);
    window.localStorage.removeItem('vibex.appUpdate.lastMainRoute');
    window.localStorage.removeItem('vibex.appUpdate.postUpdateRestore');
  });

  it('round-trips a completed check including changelog', () => {
    writeLastCheck({
      at: 1_700_000_000_000,
      currentVersion: '0.1.2',
      update: {
        version: '0.1.3',
        body: '## English\n\nNotes',
        date: '2026-08-16T00:00:00Z',
        releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        canInstall: true,
      },
    });

    expect(readLastCheck()).toEqual({
      at: 1_700_000_000_000,
      currentVersion: '0.1.2',
      update: {
        version: '0.1.3',
        body: '## English\n\nNotes',
        date: '2026-08-16T00:00:00Z',
        releaseUrl: 'https://github.com/Xircth/VibeX/releases/tag/v0.1.3',
        canInstall: true,
      },
    });
  });

  it('rejects a stored answer with a broken timestamp', () => {
    window.localStorage.setItem(
      'vibex.appUpdate.lastCheck',
      JSON.stringify({
        at: 'yesterday',
        currentVersion: '0.1.2',
        update: null,
      })
    );

    expect(readLastCheck()).toBeNull();
  });

  it('clears a cached answer after an install lands', () => {
    writeLastCheck({
      at: 1_700_000_000_000,
      currentVersion: '0.1.2',
      update: {
        version: '0.1.3',
        body: '',
        date: null,
        releaseUrl: null,
        canInstall: true,
      },
    });

    clearLastCheck();
    expect(readLastCheck()).toBeNull();
  });

  it('persists and clears dismissed update versions', () => {
    expect(readDismissedVersion()).toBeNull();

    writeDismissedVersion('0.39.0');
    expect(readDismissedVersion()).toBe('0.39.0');

    writeDismissedVersion(null);
    expect(readDismissedVersion()).toBeNull();
  });

  it('records the active main window route and restores it once after restart', () => {
    recordMainWindowRoute(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1?tab=chat'
    );
    recordMainWindowRoute('/settings/system');

    expect(readLastMainWindowRoute()).toBe(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1?tab=chat'
    );

    writePostUpdateRestoreRoute('/settings/system', 1_700_000_000_000);

    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBe(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1?tab=chat'
    );
    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBeNull();
  });

  it('expires stale post-update restore routes beyond the TTL window', () => {
    writePostUpdateRestoreRoute(
      '/local-projects/project-1/sessions',
      1_700_000_000_000
    );

    expect(
      consumePostUpdateRestoreRoute(1_700_000_000_000 + 31 * 60 * 1000)
    ).toBeNull();
  });
});
