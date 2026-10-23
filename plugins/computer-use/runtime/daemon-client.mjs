import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export function resolvePluginRoot() {
  const candidates = [
    process.env.VIBEX_PLUGIN_ROOT,
    path.dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
  ].filter(Boolean);

  for (const start of candidates) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, '.vibex-plugin', 'plugin.json'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
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
  if (process.env.VIBEX_PLUGIN_DATA_DIR) {
    return process.env.VIBEX_PLUGIN_DATA_DIR;
  }
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'vibex-plugin-computer-use');
}

export function resolveHelperBinary(pluginRoot = resolvePluginRoot()) {
  const exeName =
    process.platform === 'win32'
      ? 'vibex-computer-helper.exe'
      : 'vibex-computer-helper';
  const candidates = [
    path.join(pluginRoot, 'bin', exeName),
    path.join(pluginRoot, 'native', 'target', 'release', exeName),
    path.join(pluginRoot, 'native', 'target', 'debug', exeName),
    path.join(pluginRoot, '.git', 'cargo-target', 'release', exeName),
    path.join(pluginRoot, '.git', 'cargo-target', 'debug', exeName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export async function isDaemonHealthy(url) {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

function readDaemonUrl(dataDir, pluginRoot) {
  const files = [
    path.join(dataDir, 'daemon.json'),
    path.join(pluginRoot, '.vibex-plugin', 'daemon.json'),
  ];
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.url === 'string') {
          return parsed.url;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function writeDaemonMirrors(dataDir, url) {
  const payload = JSON.stringify(
    { url, dataDir, updatedAt: Date.now() },
    null,
    2
  );
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'daemon.json'), payload, 'utf8');
  } catch {
    // ignore
  }
}

let cachedDaemonUrl = null;
let lastHealthyAt = 0;
let spawningPromise = null;
const HEALTH_TTL_MS = 4000;

function markHealthy(url) {
  cachedDaemonUrl = url;
  lastHealthyAt = Date.now();
}

export async function ensureDaemon(envOrCtx) {
  if (cachedDaemonUrl && Date.now() - lastHealthyAt < HEALTH_TTL_MS) {
    return cachedDaemonUrl;
  }
  if (cachedDaemonUrl && (await isDaemonHealthy(cachedDaemonUrl))) {
    markHealthy(cachedDaemonUrl);
    return cachedDaemonUrl;
  }
  const pluginRoot = resolvePluginRoot();
  const dataDir = resolveDataDir(envOrCtx);
  const existingUrl = readDaemonUrl(dataDir, pluginRoot);
  if (existingUrl && (await isDaemonHealthy(existingUrl))) {
    markHealthy(existingUrl);
    writeDaemonMirrors(dataDir, existingUrl);
    return existingUrl;
  }

  if (spawningPromise) {
    return spawningPromise;
  }

  spawningPromise = (async () => {
    try {
      const bin = resolveHelperBinary(pluginRoot);
      if (!fs.existsSync(bin)) {
        throw new Error(`Computer helper binary not found at ${bin}`);
      }
      fs.mkdirSync(dataDir, { recursive: true });

      const child = spawn(bin, ['--daemon', '--data-dir', dataDir], {
        cwd: pluginRoot,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
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

      markHealthy(readyUrl);
      writeDaemonMirrors(dataDir, readyUrl);
      return readyUrl;
    } finally {
      spawningPromise = null;
    }
  })();

  return spawningPromise;
}

export async function callDaemon(envOrCtx, method, params = {}) {
  const url = await ensureDaemon(envOrCtx);
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  });
  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status} for ${method}`);
  }
  const body = await res.json();
  if (!body.ok) {
    throw new Error(body.error || `Daemon RPC error in ${method}`);
  }
  markHealthy(url);
  return body.result;
}
