import { afterEach, describe, expect, it } from 'vitest';

import { clearLastCheck, readLastCheck, writeLastCheck } from './storage';

describe('app update check storage', () => {
  afterEach(() => {
    clearLastCheck();
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
});
