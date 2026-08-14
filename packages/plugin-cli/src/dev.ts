import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const ignoredFiles = new Set([
  '.vibex-plugin/developer-link.json',
  '.vibex-plugin/package.lock.json',
]);

export async function watchPluginSources(
  root: string,
  options: {
    signal: AbortSignal;
    reload: () => Promise<void>;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    debounceMs?: number;
  }
) {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const debounceMs = options.debounceMs ?? 150;
  let baseline = await sourceDigest(root);

  while (!options.signal.aborted) {
    await delay(pollIntervalMs, options.signal);
    if (options.signal.aborted) break;
    const observed = await sourceDigest(root);
    if (observed === baseline) continue;
    await delay(debounceMs, options.signal);
    if (options.signal.aborted) break;

    let runStart = await sourceDigest(root);
    do {
      try {
        await options.reload();
      } catch (error) {
        options.onError?.(error);
      }
      const runEnd = await sourceDigest(root);
      baseline = runEnd;
      if (runEnd === runStart || options.signal.aborted) break;
      runStart = runEnd;
    } while (true);
  }
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

async function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
