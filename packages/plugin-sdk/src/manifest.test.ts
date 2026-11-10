import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTRIBUTION_ICONS,
  PERMISSION_CAPABILITIES,
  createEnvSnapshot,
  isPathWithinRoot,
  pluginManifestSchema,
  validateSafeFetchUrl,
  type AppEntrypointManifest,
  type PermissionCapability,
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

  it('declares fine-grained declarative permission capabilities in schema and types', () => {
    const expectedCapabilities: PermissionCapability[] = [
      'runtime.execute',
      'runtime.lock',
      'artifact.preview',
      'net.fetch',
      'net.websocket',
      'fs.read',
      'fs.write',
      'env.read',
      'secret.keep',
      'storage.kv',
    ];
    expect([...PERMISSION_CAPABILITIES]).toEqual(expectedCapabilities);
    expect(
      pluginManifestSchema.properties.permissions.items.properties.capability
    ).toEqual({
      enum: expectedCapabilities,
    });
  });
});

describe('declarative grants security boundary helpers', () => {
  it('enforces component-level path prefix matching and rejects parent-dir traversal', () => {
    expect(isPathWithinRoot('/home/user/project/file.txt', '/home/user')).toBe(
      true
    );
    expect(isPathWithinRoot('/home/user', '/home/user')).toBe(true);
    // Rejects naive string-prefix bypass (/home/user2 vs /home/user)
    expect(isPathWithinRoot('/home/user2/secret.txt', '/home/user')).toBe(
      false
    );
    // Rejects .. traversal segments
    expect(
      isPathWithinRoot('/home/user/../user2/secret.txt', '/home/user')
    ).toBe(false);
    expect(isPathWithinRoot('C:\\Work\\VibeX\\src\\a.ts', 'c:/Work/VibeX')).toBe(
      true
    );
    expect(
      isPathWithinRoot('C:\\Work\\VibeX-other\\a.ts', 'C:\\Work\\VibeX')
    ).toBe(false);
  });

  it('rejects URLs with @ userinfo, cloud metadata endpoints, and unlisted hosts', () => {
    expect(
      validateSafeFetchUrl('https://api.example.com/v1/items', [
        'api.example.com',
      ])
    ).toEqual({
      ok: true,
      url: 'https://api.example.com/v1/items',
      hostname: 'api.example.com',
    });

    // Rejects deceptive @ userinfo domain confusion
    expect(
      validateSafeFetchUrl('https://api.example.com@evil.com/steal', [
        'api.example.com',
        'evil.com',
      ])
    ).toEqual({
      ok: false,
      reason: 'userinfo_forbidden',
    });

    // Blocks cloud metadata endpoints by default even with wildcard allowlist
    expect(
      validateSafeFetchUrl('http://169.254.169.254/latest/meta-data/', ['*'])
    ).toEqual({
      ok: false,
      reason: 'metadata_endpoint_blocked',
      hostname: '169.254.169.254',
    });
    expect(
      validateSafeFetchUrl(
        'http://metadata.google.internal/computeMetadata/v1/',
        ['*']
      )
    ).toEqual({
      ok: false,
      reason: 'metadata_endpoint_blocked',
      hostname: 'metadata.google.internal',
    });
    expect(
      validateSafeFetchUrl('http://[fd00:ec2::254]/latest/meta-data/', ['*'])
    ).toEqual({
      ok: false,
      reason: 'metadata_endpoint_blocked',
      hostname: 'fd00:ec2::254',
    });

    // Enforces host allowlist when provided
    expect(
      validateSafeFetchUrl('https://sub.example.com/data', ['*.example.com'])
        .ok
    ).toBe(true);
    expect(
      validateSafeFetchUrl('https://other.org/data', ['*.example.com'])
    ).toEqual({
      ok: false,
      reason: 'host_not_allowed',
      hostname: 'other.org',
    });
  });

  it('creates an isolated, frozen environment snapshot with only allowlisted keys', () => {
    const rawEnv = {
      PUBLIC_API_URL: 'https://api.example.com',
      NODE_ENV: 'production',
      AWS_SECRET_ACCESS_KEY: 'super-secret',
      EMPTY_UNDEFINED: undefined,
    };

    const snapshot = createEnvSnapshot(rawEnv, [
      'PUBLIC_API_URL',
      'EMPTY_UNDEFINED',
      'MISSING_KEY',
    ]);

    expect(snapshot).toEqual({
      PUBLIC_API_URL: 'https://api.example.com',
    });
    expect('AWS_SECRET_ACCESS_KEY' in snapshot).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

