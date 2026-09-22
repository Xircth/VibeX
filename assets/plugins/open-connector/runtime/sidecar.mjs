import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const RUNTIME_ID = 'open-connector';
const HEALTH_WAIT_MS = 28_000;
const HEALTH_POLL_MS = 250;

function dataDir(env) {
  const root =
    process.env.VIBEX_HOST_DATA_DIR ||
    path.join(process.cwd(), 'plugin-state-fallback');
  return path.join(root, 'plugin-state', env.context.pluginId);
}

function redact(value) {
  return String(value ?? '')
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]')
    .replace(/enc:v1:[A-Za-z0-9+/=]+/g, 'enc:v1:[redacted]')
    .replace(/OOMOL_CONNECT_[A-Z0-9_]+=\S+/g, (match) => `${match.split('=')[0]}=[redacted]`);
}

function statusText(status) {
  const label =
    status.state === 'running'
      ? '运行中'
      : status.state === 'starting'
        ? '启动中'
        : status.state === 'unhealthy'
          ? '不健康'
          : '已停止';
  return {
    text: `Open Connector · ${label}`,
    tooltip: status.origin ? `${label} ${status.origin}` : label,
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readSecret(file) {
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    if (!raw) return '';
    if (raw.startsWith('"') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' ? parsed : raw;
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    return '';
  }
}

async function writeSecret(file, value) {
  await writeFile(file, value, { encoding: 'utf8', mode: 0o600 });
}

export { readSecret, writeSecret };

async function reservePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
  if (preferred) {
    try {
      return await tryPort(preferred);
    } catch {
      // Fall through to an ephemeral port.
    }
  }
  return tryPort(0);
}

async function waitForHealth(origin, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'sidecar did not become ready';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
      lastError = `health ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(lastError);
}

export function createSidecar(environment) {
  const dir = dataDir(environment);
  const secretsDir = path.join(dir, 'secrets');
  const runtimeFile = path.join(dir, 'runtime.json');
  const keyFile = path.join(secretsDir, 'encryption.key');
  const tokenFile = path.join(secretsDir, 'runtime.token');
  const mcpTokenFile = path.join(secretsDir, 'mcp.token');
  let child = null;
  let starting = null;
  let state = 'stopped';
  let origin;
  let pid;
  let lastError;
  let token = '';
  const controller = new AbortController();

  const snapshot = () => ({
    state,
    origin,
    pid,
    dataDir: dir,
    adminAuthConfigured: false,
    lastError,
  });

  async function ensureSecrets() {
    await mkdir(secretsDir, { recursive: true });
    token = await readSecret(tokenFile);
    if (!token) {
      token = randomBytes(32).toString('hex');
      await writeSecret(tokenFile, token);
    }
    let encryptionKey = await readSecret(keyFile);
    if (!encryptionKey) {
      encryptionKey = randomBytes(32).toString('hex');
      await writeSecret(keyFile, encryptionKey);
    }
    return { token, encryptionKey };
  }

  async function ensureIssuedRuntimeToken(base) {
    const saved = await readSecret(mcpTokenFile);
    let listed = [];
    try {
      const response = await fetch(`${base}/api/runtime-tokens`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        listed = await response.json();
      }
    } catch {
      listed = [];
    }
    if (saved.startsWith('oct_') && Array.isArray(listed) && listed.length > 0) {
      token = saved;
      return saved;
    }
    const response = await fetch(`${base}/api/runtime-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'VibeX',
        allowedActions: ['*'],
        blockedActions: [],
        allowedProxies: ['*'],
        allowedConnections: [],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`runtime token ${response.status}`);
    }
    const body = await response.json();
    const issued = String(body?.token || '');
    if (!issued.startsWith('oct_')) {
      throw new Error('runtime token was not issued');
    }
    await writeSecret(mcpTokenFile, issued);
    token = issued;
    return issued;
  }

  async function settings() {
    const stored = await environment.host.call('storage', 'settings.get', {});
    const value = stored && typeof stored === 'object' ? stored : {};
    return {
      catalogLazySchemas: value.catalogLazySchemas !== false,
      allowPrivateNetwork: value.allowPrivateNetwork === true,
      trustedHosts: typeof value.trustedHosts === 'string' ? value.trustedHosts : '',
    };
  }

  async function spawnSidecar() {
    state = 'starting';
    lastError = undefined;
    origin = undefined;
    pid = undefined;
    const lock = await environment.host.call('runtime.lock', 'get', {
      runtimeId: RUNTIME_ID,
    });
    await mkdir(dir, { recursive: true });
    const secrets = await ensureSecrets();
    const executablePath = lock?.executablePath;
    if (typeof executablePath !== 'string' || !executablePath) {
      throw new Error('runtime.lock did not return executablePath');
    }
    const previous = await readJson(runtimeFile, {});
    const port = await reservePort(previous.port);
    origin = `http://127.0.0.1:${port}`;
    const cfg = await settings();
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('OOMOL_CONNECT_')) delete env[key];
    }
    env.HOST = '127.0.0.1';
    env.PORT = String(port);
    env.OOMOL_CONNECT_ORIGIN = origin;
    env.OOMOL_CONNECT_DATA_DIR = dir;
    env.OOMOL_CONNECT_ENCRYPTION_KEY = secrets.encryptionKey;
    env.OOMOL_CONNECT_RUNTIME_TOKEN = secrets.token;
    env.OOMOL_CONNECT_CATALOG_LAZY_SCHEMAS = cfg.catalogLazySchemas ? 'true' : 'false';
    env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK = cfg.allowPrivateNetwork ? 'true' : 'false';
    if (cfg.trustedHosts.trim()) {
      env.OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS = cfg.trustedHosts.trim();
    }
    delete env.OOMOL_CONNECT_ADMIN_TOKEN;
    child = spawn(executablePath, [], {
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    pid = child.pid;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      environment.log.warn(redact(chunk).slice(0, 500));
    });
    child.on('exit', (code) => {
      if (state === 'stopped') return;
      state = 'unhealthy';
      lastError = redact(`sidecar exited ${code ?? 'null'}`);
      child = null;
    });
    await writeFile(
      runtimeFile,
      JSON.stringify({ origin, port, pid, startedAt: Date.now() }),
    );
    await waitForHealth(origin, HEALTH_WAIT_MS, controller.signal);
    try {
      await ensureIssuedRuntimeToken(origin);
    } catch (error) {
      environment.log.warn(
        redact(error instanceof Error ? error.message : String(error)),
      );
    }
    state = 'running';
    lastError = undefined;
    return snapshot();
  }

  function killChild() {
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Windows may already have ended the process.
    }
    child = null;
  }

  return {
    status() {
      return snapshot();
    },
    statusText() {
      return statusText(snapshot());
    },
    start() {
      if (state === 'running' && child) return Promise.resolve(snapshot());
      if (starting) return starting;
      starting = spawnSidecar()
        .catch((error) => {
          killChild();
          state = 'unhealthy';
          lastError = redact(error instanceof Error ? error.message : error);
          return snapshot();
        })
        .finally(() => {
          starting = null;
        });
      return starting;
    },
    async waitUntilReady() {
      const current = await this.start();
      if (current.state === 'running' && current.origin) return current;
      throw new Error(current.lastError || 'sidecar is not ready');
    },
    async endpoint() {
      const ready = await this.waitUntilReady();
      return {
        url: `${ready.origin}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      };
    },
    async health() {
      const before = origin;
      if (state === 'stopped' || !origin) {
        return { ok: false, originChanged: false };
      }
      try {
        await waitForHealth(origin, 2000, controller.signal);
        state = 'running';
        lastError = undefined;
        return { ok: true, originChanged: false };
      } catch (error) {
        state = 'unhealthy';
        lastError = redact(error instanceof Error ? error.message : error);
        return { ok: false, originChanged: before !== origin };
      }
    },
    async restart() {
      killChild();
      state = 'stopped';
      return this.start();
    },
    async wipeData() {
      killChild();
      state = 'stopped';
      origin = undefined;
      pid = undefined;
      await rm(dir, { recursive: true, force: true });
      lastError = undefined;
      token = '';
      return snapshot();
    },
    async dispose() {
      controller.abort();
      killChild();
      state = 'stopped';
    },
  };
}
