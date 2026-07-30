import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const TOKEN = 'vibex-production-web-e2e-token-00000001';

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('could not reserve a loopback port'));
        return;
      }
      reservation.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitUntilReady(
  baseUrl: string,
  child: ChildProcess
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vibex-server exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('timed out waiting for vibex-server');
}

export default async function setup() {
  const frontendRoot = resolve(import.meta.dirname, '..');
  const repositoryRoot = resolve(frontendRoot, '..');
  const dataDir = mkdtempSync(resolve(tmpdir(), 'vibex-web-e2e-'));
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const executable =
    process.platform === 'win32'
      ? resolve(repositoryRoot, 'target', 'debug', 'vibex-server.exe')
      : resolve(repositoryRoot, 'target', 'debug', 'vibex-server');
  const child = spawn(executable, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RUST_LOG: 'warn',
      VIBEX_DATA_DIR: dataDir,
      VIBEX_SERVER_LISTEN: `127.0.0.1:${port}`,
      VIBEX_SERVER_TOKEN: TOKEN,
      VIBEX_STATIC_ROOT: resolve(frontendRoot, 'dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));

  try {
    await waitUntilReady(baseUrl, child);
  } catch (error) {
    child.kill();
    throw new Error(`${String(error)}\n${output.join('')}`);
  }
  process.env.VIBEX_E2E_BASE_URL = baseUrl;
  process.env.VIBEX_E2E_TOKEN = TOKEN;

  return async () => {
    child.kill();
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit();
        return;
      }
      child.once('exit', () => resolveExit());
      setTimeout(() => {
        child.kill('SIGKILL');
        resolveExit();
      }, 2_000).unref();
    });
    rmSync(dataDir, { recursive: true, force: true });
  };
}
