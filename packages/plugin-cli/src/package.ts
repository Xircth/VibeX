import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import AdmZip from 'adm-zip';

export interface PackageLock {
  lockVersion: 1;
  packageDigest: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  build: { cliVersion: string; reproducible: true };
}

export async function createPackageLock(root: string): Promise<PackageLock> {
  const files = await packageFiles(root);
  return createLockForFiles(root, files);
}

async function createLockForFiles(
  root: string,
  files: readonly string[]
): Promise<PackageLock> {
  const entries = await Promise.all(
    files.map(async (path) => {
      const data = await readFile(join(root, path));
      return { path, size: data.byteLength, sha256: hash(data) };
    })
  );
  const packageDigest = hash(
    Buffer.from(
      entries
        .map((item) => `${item.path}\0${item.size}\0${item.sha256}`)
        .join('\n')
    )
  );
  return {
    lockVersion: 1,
    packageDigest,
    files: entries,
    build: { cliVersion: '1.0.0', reproducible: true },
  };
}

export async function packPlugin(root: string, output?: string) {
  const releaseFiles = (await packageFiles(root)).filter(
    (path) =>
      path !== 'runtime' &&
      !path.startsWith('runtime/') &&
      path !== 'test' &&
      !path.startsWith('test/') &&
      path !== 'package.json' &&
      path !== 'pnpm-lock.yaml' &&
      path !== 'package-lock.json' &&
      path !== 'yarn.lock' &&
      !path.endsWith('.map')
  );
  const lock = await createLockForFiles(root, releaseFiles);
  const lockPath = join(root, '.vibex-plugin', 'package.lock.json');
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const zip = new AdmZip();
  for (const path of releaseFiles) {
    const data = await readFile(join(root, path));
    zip.addFile(path.replaceAll('\\', '/'), data, '', 0o100644 << 16);
    const entry = zip.getEntry(path.replaceAll('\\', '/'));
    if (entry) entry.header.time = new Date('1980-01-01T00:00:00.000Z');
  }
  const config = await readFile(join(root, 'config.json'));
  zip.addFile('config.json', config, '', 0o100644 << 16);
  const configEntry = zip.getEntry('config.json');
  if (configEntry) configEntry.header.time = new Date('1980-01-01T00:00:00.000Z');
  zip.addFile(
    '.vibex-plugin/package.lock.json',
    Buffer.from(`${JSON.stringify(lock, null, 2)}\n`),
    '',
    0o100644 << 16
  );
  const lockEntry = zip.getEntry('.vibex-plugin/package.lock.json');
  if (lockEntry) lockEntry.header.time = new Date('1980-01-01T00:00:00.000Z');
  const manifest = JSON.parse(
    await readFile(join(root, '.vibex-plugin', 'plugin.json'), 'utf8')
  ) as { id: string; version: string };
  const target = resolve(
    output ?? join(root, 'dist', `${manifest.id}-${manifest.version}.vxp`)
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, zip.toBuffer());
  return { output: target, lock };
}

async function packageFiles(root: string) {
  const paths: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (path === 'config.json') continue;
      if (path === '.vibex-plugin/package.lock.json') continue;
      if (path === '.vibex-plugin/developer-link.json') continue;
      if (entry.isSymbolicLink())
        throw new Error(`package_symlink_rejected: ${path}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && !entry.name.endsWith('.vxp')) paths.push(path);
    }
  }
  await visit(root);
  return paths.sort();
}

function hash(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

export function defaultPluginName(path: string) {
  return basename(resolve(path))
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-');
}
