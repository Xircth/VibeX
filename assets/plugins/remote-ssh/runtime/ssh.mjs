import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_REMOTE_PORT = 17891;

export async function pickLocalPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export function createSshSession(target, io = defaultIo()) {
  const host = String(target.host ?? '').trim();
  const user = String(target.user ?? '').trim();
  const port = Number(target.port ?? 22);
  const password = target.password ? String(target.password) : '';
  const jump = String(target.jump ?? '').trim();
  if (!host) throw new Error('host is required');
  if (!user) throw new Error('user is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port is invalid');
  }

  let askpassDir;
  const forwards = new Set();

  async function ensureAskpass() {
    if (!password || askpassDir) return askpassDir;
    askpassDir = await mkdtemp(join(tmpdir(), 'vibex-ssh-'));
    const helper = join(askpassDir, 'askpass.sh');
    await writeFile(
      helper,
      '#!/bin/sh\nprintf \'%s\\n\' "$SSH_ASKPASS_PASSWORD"\n',
      { encoding: 'utf8' }
    );
    await chmod(helper, 0o700);
    return askpassDir;
  }

  async function sshEnv() {
    const env = { ...process.env, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
    if (!password) return env;
    const dir = await ensureAskpass();
    env.SSH_ASKPASS = join(dir, 'askpass.sh');
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.SSH_ASKPASS_PASSWORD = password;
    if (!env.DISPLAY) env.DISPLAY = ':0';
    return env;
  }

  function sshArgs(extra) {
    const args = [
      '-p',
      String(port),
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'UpdateHostKeys=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      password ? 'PreferredAuthentications=password,keyboard-interactive,publickey' : 'BatchMode=yes',
      '-o',
      'ConnectTimeout=20',
    ];
    if (jump) args.push('-J', jump);
    args.push(...extra, `${user}@${host}`);
    return args;
  }

  async function exec(command, timeoutMs = 120000) {
    const env = await sshEnv();
    const result = await io.run('ssh', sshArgs([command]), {
      env,
      timeoutMs,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `ssh exited ${result.code}`).trim();
      throw new Error(detail);
    }
    return result.stdout;
  }

  async function forward(remotePort = DEFAULT_REMOTE_PORT) {
    const localPort = await pickLocalPort();
    const env = await sshEnv();
    const child = io.spawn(
      'ssh',
      sshArgs([
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ]),
      { env }
    );
    const session = { localPort, remotePort, child };
    forwards.add(session);
    await waitForListen(localPort, child, 20000);
    return {
      origin: `http://127.0.0.1:${localPort}`,
      localPort,
      async close() {
        forwards.delete(session);
        await io.kill(child);
      },
    };
  }

  async function close() {
    await Promise.all([...forwards].map((item) => io.kill(item.child)));
    forwards.clear();
    if (askpassDir) {
      await rm(askpassDir, { recursive: true, force: true });
      askpassDir = undefined;
    }
  }

  return { host, user, port, jump, exec, forward, close };
}

export function defaultIo() {
  return {
    run(command, args, options) {
      return runProcess(command, args, options);
    },
    spawn(command, args, options) {
      return spawn(command, args, {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
    async kill(child) {
      if (!child || child.killed || child.exitCode != null) return;
      child.kill('SIGTERM');
      await Promise.race([
        waitExit(child),
        sleep(1500).then(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        }),
      ]);
    },
  };
}

function runProcess(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ssh timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    child.once('close', resolve);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForListen(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  child.stderr?.on('data', (chunk) => {
    lastError += chunk.toString('utf8');
  });
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error((lastError || `ssh tunnel exited ${child.exitCode}`).trim());
    }
    const open = await probePort(port);
    if (open) return;
    await sleep(150);
  }
  throw new Error(lastError.trim() || 'ssh tunnel did not become ready');
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(400, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function secretKey(target) {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

export function nonce() {
  return randomBytes(6).toString('hex');
}
