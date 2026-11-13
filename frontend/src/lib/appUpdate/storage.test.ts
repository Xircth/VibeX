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

  it.each([
    '/local-projects',
    '/local-projects/project-1',
    '/local-projects/project-1/sessions',
    '/local-projects/project-1/workspaces/workspace-1',
    '/local-projects/project-1/workspaces/workspace-1/sessions/session-1?tab=chat#message-1',
    '/local-projects/project-1/workspaces/workspace-1/full',
    '/workflows/run-1',
  ])('preserves supported route %s on restart', (route) => {
    recordMainWindowRoute(route);
    writePostUpdateRestoreRoute(route, 1_700_000_000_000);

    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBe(route);
  });

  it('restores legacy attempt routes into the current workspace route', () => {
    writePostUpdateRestoreRoute(
      '/local-projects/project-1/tasks/task-1/attempts/workspace-1?view=canvas#message-1',
      1_700_000_000_000
    );

    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBe(
      '/local-projects/project-1/workspaces/workspace-1?view=canvas#message-1'
    );
  });

  it.each([
    '/settings/system',
    '/plugins/vibex.browser',
    '/unknown',
    'https://example.com',
  ])('does not restore unsupported main-window route %s', (route) => {
    window.localStorage.setItem('vibex.appUpdate.lastMainRoute', route);
    expect(readLastMainWindowRoute()).toBeNull();
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

  it('repairs a remembered file address before returning to the main window', () => {
    window.localStorage.setItem(
      'vibex.appUpdate.lastMainRoute',
      '/local-projects/project-1/workspaces/workspace-1/evidence/image.png'
    );

    expect(readLastMainWindowRoute()).toBe(
      '/local-projects/project-1/workspaces/workspace-1'
    );
  });

  it('records a working parent when an unsupported file address is visited', () => {
    recordMainWindowRoute(
      '/local-projects/project-1/workspaces/workspace-1/evidence/image.png'
    );

    expect(readLastMainWindowRoute()).toBe(
      '/local-projects/project-1/workspaces/workspace-1'
    );
  });

  it('repairs file addresses stored by an older updater', () => {
    window.localStorage.setItem(
      'vibex.appUpdate.postUpdateRestore',
      JSON.stringify({
        route:
          '/local-projects/project-1/workspaces/workspace-1/evidence/image.png',
        at: 1_700_000_000_000,
      })
    );

    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBe(
      '/local-projects/project-1/workspaces/workspace-1'
    );
  });

  it('falls back to the last valid page when an update starts from an unknown address', () => {
    recordMainWindowRoute('/local-projects/project-1/sessions');
    recordMainWindowRoute('/unknown');
    writePostUpdateRestoreRoute('/unknown', 1_700_000_000_000);

    expect(consumePostUpdateRestoreRoute(1_700_000_010_000)).toBe(
      '/local-projects/project-1/sessions'
    );
  });
});
