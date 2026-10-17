import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidTauriEventName } from '@/lib/tauriEventName';
import { BROWSER_HOST_EVENT } from './browserHostEvent';

const repoRoot = resolve(__dirname, '../../../..');

function readRepoFile(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('BROWSER_HOST_EVENT', () => {
  it('is a legal Tauri listen name', () => {
    expect(isValidTauriEventName(BROWSER_HOST_EVENT)).toBe(true);
    expect(BROWSER_HOST_EVENT).toBe('plugin:browser');
  });

  it('is the only name native browser emit/listen sites use', () => {
    const files = [
      'src-tauri/src/browser_native.rs',
      'frontend/src/features/host-browser/HostBrowserPanel.tsx',
      'frontend/src/features/host-browser/openBrowserTab.ts',
      'frontend/src/contexts/PanelActionsContext.tsx',
    ];

    for (const file of files) {
      const source = readRepoFile(file);
      expect(source, file).not.toMatch(/plugin\.browser/);
      expect(source, file).toMatch(/plugin:browser|BROWSER_HOST_EVENT/);
    }
  });
});
