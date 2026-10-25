import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTRIBUTION_ICONS,
  pluginManifestSchema,
  type AppEntrypointManifest,
  type VibeXPluginManifest,
  type WorkerEntrypointManifest,
} from './manifest.js';

describe('contribution icons', () => {
  it('match the published contract catalog', async () => {
    const catalogUrl = new URL(
      '../../plugin-contract/catalog/icons.v1.json',
      import.meta.url
    );
    const catalog = JSON.parse(
      await readFile(fileURLToPath(catalogUrl), 'utf8')
    ) as { icons: string[] };

    expect([...CONTRIBUTION_ICONS]).toEqual(catalog.icons);
  });

  it('are sorted and unique so the set stays reviewable', () => {
    const sorted = [...CONTRIBUTION_ICONS].sort();
    expect([...CONTRIBUTION_ICONS]).toEqual(sorted);
    expect(new Set(CONTRIBUTION_ICONS).size).toBe(CONTRIBUTION_ICONS.length);
  });
});

describe('plugin manifest contract', () => {
  it('accepts apiVersion 1.0 and 2.0 plus both App protocols', () => {
    const v1App: AppEntrypointManifest = {
      root: 'dist/app',
      document: 'index.html',
      protocol: '1.0',
    };
    const v2App: AppEntrypointManifest = {
      entry: 'dist/app.js',
      styles: 'dist/app.css',
      protocol: '2.0',
    };
    const worker: WorkerEntrypointManifest = {
      path: 'dist/worker.mjs',
      runtime: 'node',
      protocol: '1.1',
      maxFrameMiB: 32,
      sharedWorker: true,
      isolation: 'shared',
    };
    const v1: VibeXPluginManifest = {
      manifestVersion: 4,
      apiVersion: '1.0',
      id: 'hello.notes',
      publisher: 'acme',
      version: '0.1.0',
      name: 'Notes',
      entrypoints: { worker, app: v1App },
    };
    const v2: VibeXPluginManifest = {
      ...v1,
      apiVersion: '2.0',
      entrypoints: { worker, app: v2App },
    };
    expect(v1.apiVersion).toBe('1.0');
    expect(v2.apiVersion).toBe('2.0');
    expect(pluginManifestSchema.properties.apiVersion).toEqual({
      enum: ['1.0', '2.0'],
    });
  });
});
