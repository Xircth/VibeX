import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';

import { createPackageLock, packPlugin } from './package.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('deterministic package boundary', () => {
  it('hashes files inside a .vxp directory but excludes archive files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-package-'));
    roots.push(root);
    await mkdir(join(root, '.vibex-plugin'), { recursive: true });
    await mkdir(join(root, 'cache.vxp'), { recursive: true });
    await writeFile(
      join(root, '.vibex-plugin/plugin.json'),
      '{"id":"sample","version":"1.0.0"}'
    );
    await writeFile(join(root, 'cache.vxp/nested.txt'), 'included');
    await writeFile(join(root, 'old.vxp'), 'excluded');

    const lock = await createPackageLock(root);

    expect(lock.files.map((file) => file.path)).toContain(
      'cache.vxp/nested.txt'
    );
    expect(lock.files.map((file) => file.path)).not.toContain('old.vxp');
  });

  it('ships runtime artifacts without source trees or source maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-package-'));
    roots.push(root);
    await mkdir(join(root, '.vibex-plugin'), { recursive: true });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(
      join(root, '.vibex-plugin/plugin.json'),
      '{"id":"sample","version":"1.0.0"}'
    );
    await writeFile(join(root, 'runtime/main.mjs'), 'secret source');
    await writeFile(join(root, 'config.json'), '{}');
    await writeFile(join(root, 'dist/worker.mjs'), 'release');
    await writeFile(join(root, 'dist/worker.mjs.map'), '/absolute/checkout');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'file: /absolute/checkout');

    const { output } = await packPlugin(root, join(root, 'sample.vxp'));
    const zip = new AdmZip(await readFile(output));
    const names = zip.getEntries().map((entry) => entry.entryName);

    expect(names).toContain('dist/worker.mjs');
    expect(names).not.toContain('runtime/main.mjs');
    expect(names).toContain('config.json');
    expect(names).not.toContain('dist/worker.mjs.map');
    expect(names).not.toContain('package.json');
    expect(names).not.toContain('pnpm-lock.yaml');
  });
});
