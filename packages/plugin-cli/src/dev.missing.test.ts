import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const missing = vi.hoisted(() => ({
  paths: new Set<string>(),
  failCode: '' as string,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  return {
    ...actual,
    async readFile(
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) {
      const name = String(path).replaceAll('\\', '/');
      for (const marker of missing.paths) {
        if (!name.endsWith(marker)) continue;
        const error = new Error(`missing ${name}`) as NodeJS.ErrnoException;
        error.code = missing.failCode || 'ENOENT';
        throw error;
      }
      return actual.readFile(path, options);
    },
  };
});

import { watchPluginSources } from './dev.js';

afterEach(() => {
  missing.paths.clear();
  missing.failCode = '';
});

describe('watchPluginSources missing files', () => {
  it('keeps watching when a listed file disappears before it is read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-watch-'));
    const source = join(root, 'worker.mjs');
    await writeFile(source, 'export default 1;');
    await writeFile(join(root, 'fleeting.tmp'), 'temp');
    const controller = new AbortController();
    const errors: unknown[] = [];
    let reloads = 0;
    const watching = watchPluginSources(root, {
      signal: controller.signal,
      debounceMs: 15,
      async reload() {
        reloads += 1;
        controller.abort();
      },
      onError: (error) => errors.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    missing.paths.add('/fleeting.tmp');
    await writeFile(source, 'export default 2;');
    const giveUp = setTimeout(() => controller.abort(), 2000);
    await watching;
    clearTimeout(giveUp);

    expect(reloads).toBe(1);
    expect(errors).toEqual([]);
  });

  it('reports a digest failure and leaves the watcher running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-watch-'));
    const source = join(root, 'worker.mjs');
    await writeFile(source, 'export default 1;');
    await writeFile(join(root, 'locked.tmp'), 'temp');
    const controller = new AbortController();
    const errors: unknown[] = [];
    let reloads = 0;
    const watching = watchPluginSources(root, {
      signal: controller.signal,
      debounceMs: 15,
      async reload() {
        reloads += 1;
      },
      onError: (error) => errors.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    missing.failCode = 'EIO';
    missing.paths.add('/locked.tmp');
    await writeFile(source, 'export default 2;');
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await watching;

    expect(reloads).toBe(0);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'EIO' }),
    ]);
  });
});
