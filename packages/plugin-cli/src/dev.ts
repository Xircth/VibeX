import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const ignoredFiles = new Set([
  '.vibex-plugin/developer-link.json',
  '.vibex-plugin/package.lock.json',
]);

export type PluginSourceWatcher = {
  close(): void;
};

export type CreatePluginSourceWatcher = (
  root: string,
  listener: () => void
) => PluginSourceWatcher;

export async function watchPluginSources(
  root: string,
  options: {
    signal: AbortSignal;
    reload: () => Promise<void>;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    debounceMs?: number;
    createWatcher?: CreatePluginSourceWatcher;
  }
) {
  const debounceMs = options.debounceMs ?? 150;
  let baseline = await sourceDigest(root);
  let timer: NodeJS.Timeout | undefined;
  let reloading = false;
  let queued = false;

  const runReload = async () => {
    if (reloading) {
      queued = true;
      return;
    }
    reloading = true;
    try {
      do {
        queued = false;
        if (options.signal.aborted) return;
        const observed = await sourceDigest(root);
        if (observed === baseline && !queued) return;
        try {
          await options.reload();
        } catch (error) {
          options.onError?.(error);
        }
        baseline = observed;
        const after = await sourceDigest(root);
        if (after !== observed) queued = true;
      } while (queued && !options.signal.aborted);
    } finally {
      reloading = false;
    }
  };

  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void runReload();
    }, debounceMs);
  };

  const createWatcher =
    options.createWatcher ??
    ((directory, listener) =>
      watch(directory, { recursive: true }, () => listener()));
  const watcher = createWatcher(root, trigger);
  options.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      watcher.close();
    },
    { once: true },
  );
  await new Promise<void>((resolve) => {
    options.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function sourceDigest(root: string) {
  const hash = createHash('sha256');
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (ignoredFiles.has(path) || path.endsWith('.vxp')) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  for (const path of files.sort()) {
    hash
      .update(path)
      .update('\0')
      .update(await readFile(join(root, path)));
  }
  return hash.digest('hex');
}
