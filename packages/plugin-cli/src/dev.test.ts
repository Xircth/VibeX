import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { watchPluginSources } from './dev.js';

describe('watchPluginSources', () => {
  it('debounces changes, serializes reloads, and reruns when source changes during a reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-watch-'));
    const source = join(root, 'worker.mjs');
    await writeFile(source, 'export default 1;');
    const controller = new AbortController();
    let active = 0;
    let maximumActive = 0;
    let reloads = 0;

    const watching = watchPluginSources(root, {
      signal: controller.signal,
      pollIntervalMs: 10,
      debounceMs: 10,
      async reload() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        reloads += 1;
        if (reloads === 1) {
          await writeFile(source, 'export default 3;');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        active -= 1;
        if (reloads === 2) controller.abort();
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(source, 'export default 2;');
    await watching;

    expect(reloads).toBe(2);
    expect(maximumActive).toBe(1);
  });

  it('continues watching after a candidate reload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-watch-'));
    const source = join(root, 'worker.mjs');
    await writeFile(source, 'export default 1;');
    const controller = new AbortController();
    const errors: unknown[] = [];
    let reloads = 0;

    const watching = watchPluginSources(root, {
      signal: controller.signal,
      pollIntervalMs: 10,
      debounceMs: 10,
      async reload() {
        reloads += 1;
        if (reloads === 1) throw new Error('candidate rejected');
        controller.abort();
      },
      onError: (error) => errors.push(error),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(source, 'export default 2;');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(source, 'export default 3;');
    await watching;

    expect(reloads).toBe(2);
    expect(errors).toEqual([
      expect.objectContaining({ message: 'candidate rejected' }),
    ]);
  });
});
