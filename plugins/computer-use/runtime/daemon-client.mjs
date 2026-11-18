import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export function resolvePluginRoot() {
  const candidates = [
    process.env.DIMO_PLUGIN_ROOT,
    path.dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
  ].filter(Boolean);

  for (const start of candidates) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, '.dimo-plugin', 'plugin.json'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

function defaultUserDataDir() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'dimo-plugin-computer-use');
}

export function resolveDataDir(envOrCtx) {
  if (
    envOrCtx &&
    typeof envOrCtx === 'object' &&
    typeof envOrCtx.pluginDataDir === 'string' &&
    envOrCtx.pluginDataDir
  ) {
    return envOrCtx.pluginDataDir;
  }
  if (process.env.DIMO_PLUGIN_DATA_DIR) {
    return process.env.DIMO_PLUGIN_DATA_DIR;
  }
  return defaultUserDataDir();
}

export function resolveHelperBinary(pluginRoot = resolvePluginRoot()) {
  const exeName =
    process.platform === 'win32'
      ? 'dimo-computer-helper.exe'
      : 'dimo-computer-helper';
  const repoRootFromSnapshot = path.resolve(pluginRoot, '..', '..', '..', '..', '..');
  const candidates = [
    path.join(pluginRoot, 'bin', exeName),
    path.join(pluginRoot, 'native', 'target', 'release', exeName),
    path.join(pluginRoot, 'native', 'target', 'debug', exeName),
    path.join(pluginRoot, '.git', 'cargo-target', 'release', exeName),
    path.join(pluginRoot, '.git', 'cargo-target', 'debug', exeName),
    path.join(repoRootFromSnapshot, 'plugins', 'computer-use', 'bin', exeName),
    path.join(repoRootFromSnapshot, 'plugins', 'computer-use', 'native', 'target', 'release', exeName),
    path.join(repoRootFromSnapshot, 'plugins', 'computer-use', 'native', 'target', 'debug', exeName),
    path.join(
      pluginRoot,
      '..',
      '..',
      'dev_assets',
      'plugins',
      'runtimes',
      'plugins',
      'snapshots',
      'dimo-plugin-computer-use',
      'bin',
      exeName
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export async function isDaemonHealthy(url, token) {
  if (!url || !token) return false;
  let timer = null;
  try {
    const res = await Promise.race([
      fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 1500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!res || !res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok && data.auth === true);
  } catch {
    if (timer) clearTimeout(timer);
    return false;
  }
}

function readDaemonInfo(dataDir) {
  const file = path.join(dataDir, 'daemon.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        parsed &&
        typeof parsed.url === 'string' &&
        parsed.url &&
        typeof parsed.token === 'string' &&
        parsed.token
      ) {
        return { url: parsed.url, token: parsed.token };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

let cachedDaemon = null;
let lastHealthyAt = 0;
let spawningPromise = null;
const HEALTH_TTL_MS = 4000;

function markHealthy(info) {
  cachedDaemon = info;
  lastHealthyAt = Date.now();
}

export async function ensureDaemonAuth(envOrCtx) {
  if (cachedDaemon && Date.now() - lastHealthyAt < HEALTH_TTL_MS) {
    return cachedDaemon;
  }
  if (cachedDaemon && (await isDaemonHealthy(cachedDaemon.url, cachedDaemon.token))) {
    markHealthy(cachedDaemon);
    return cachedDaemon;
  }
  const pluginRoot = resolvePluginRoot();
  const dataDir = resolveDataDir(envOrCtx);
  const existing = readDaemonInfo(dataDir);
  if (existing && (await isDaemonHealthy(existing.url, existing.token))) {
    markHealthy(existing);
    return existing;
  }

  if (spawningPromise) {
    return spawningPromise;
  }

  spawningPromise = (async () => {
    try {
      let bin = resolveHelperBinary(pluginRoot);
      if (!fs.existsSync(bin)) {
        const repoRootFromSnapshot = path.resolve(
          pluginRoot,
          '..',
          '..',
          '..',
          '..',
          '..'
        );
        const manifestCandidates = [
          path.join(pluginRoot, 'native', 'Cargo.toml'),
          path.join(
            repoRootFromSnapshot,
            'plugins',
            'computer-use',
            'native',
            'Cargo.toml'
          ),
        ];
        const manifestPath = manifestCandidates.find((candidate) =>
          fs.existsSync(candidate)
        );
        if (manifestPath) {
          spawnSync(
            'cargo',
            ['build', '--release', '--manifest-path', manifestPath],
            { stdio: 'ignore' }
          );
          bin = resolveHelperBinary(pluginRoot);
        }
      }
      if (!fs.existsSync(bin)) {
        throw new Error(`Computer helper binary not found at ${bin}`);
      }
      fs.mkdirSync(dataDir, { recursive: true });

      const child = spawn(bin, ['--daemon', '--data-dir', dataDir], {
        cwd: pluginRoot,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      });

      const readyUrl = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for computer daemon to start'));
        }, 10000);

        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('DAEMON_READY ')) {
            clearTimeout(timeout);
            const url = trimmed.slice('DAEMON_READY '.length).trim();
            rl.close();
            resolve(url);
          }
        });

        let stderrBuf = '';
        child.stderr.on('data', (chunk) => {
          stderrBuf += String(chunk);
        });

        child.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `Computer daemon exited early (code ${code}): ${stderrBuf.trim()}`
            )
          );
        });
      });

      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();

      const info = readDaemonInfo(dataDir);
      if (!info || info.url !== readyUrl) {
        throw new Error('Computer daemon started without valid daemon.json credentials');
      }
      markHealthy(info);
      return info;
    } finally {
      spawningPromise = null;
    }
  })();

  return spawningPromise;
}

export async function ensureDaemon(envOrCtx) {
  const info = await ensureDaemonAuth(envOrCtx);
  return info.url;
}

export async function callDaemon(envOrCtx, method, params = {}) {
  let info = await ensureDaemonAuth(envOrCtx);
  let res = await fetch(`${info.url}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${info.token}`,
    },
    body: JSON.stringify({ method, params: params ?? {} }),
  });
  if (res.status === 401) {
    cachedDaemon = null;
    lastHealthyAt = 0;
    info = await ensureDaemonAuth(envOrCtx);
    res = await fetch(`${info.url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify({ method, params: params ?? {} }),
    });
  }
  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status} for ${method}`);
  }
  const body = await res.json();
  if (!body.ok) {
    throw new Error(body.error || `Daemon RPC error in ${method}`);
  }
  markHealthy(info);
  return body.result;
}
