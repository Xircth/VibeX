import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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

export function sshArgv(target, { options = [], command } = {}) {
  const host = String(target.host ?? '').trim();
  const user = String(target.user ?? '').trim();
  const port = Number(target.port ?? 22);
  const jump = String(target.jump ?? '').trim();
  const password = target.password ? String(target.password) : '';
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
    'GSSAPIAuthentication=no',
    '-o',
    'ConnectTimeout=20',
  ];
  if (password) {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PasswordAuthentication=yes',
      '-o',
      'KbdInteractiveAuthentication=yes',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1'
    );
  } else {
    args.push(
      '-o',
      'BatchMode=yes',
      '-o',
      'PreferredAuthentications=publickey'
    );
  }
  if (jump) args.push('-J', jump);
  args.push(...options);
  args.push('--', `${user}@${host}`);
  if (command != null && command !== '') args.push(command);
  return args;
}

export function createSshSession(target, io = defaultIo(), hooks = {}) {
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
  const destination = { host, user, port, jump, password };
  const hasAgent = hooks.agentAvailable ?? sshAgentAvailable;

  let askpassDir;
  let controlPath;
  const forwards = new Set();

  async function muxOptions() {
    if (!controlPath) {
      const dir = await mkdtemp(join(tmpdir(), 'vibex-ssh-cm-'));
      controlPath = join(dir, 'c');
    }
    return [
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=30',
    ];
  }

  async function ensureAskpass() {
    if (!password || askpassDir) return askpassDir;
    askpassDir = await mkdtemp(join(tmpdir(), 'vibex-ssh-'));
    const secret = join(askpassDir, 'secret');
    const helper = join(askpassDir, 'askpass.sh');
    await writeFile(
      secret,
      password.endsWith('\n') ? password : `${password}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await chmod(secret, 0o600);
    await writeFile(
      helper,
      `#!/bin/sh\nexec /bin/cat ${shellSingleQuote(secret)}\n`,
      { encoding: 'utf8' }
    );
    await chmod(helper, 0o700);
    return askpassDir;
  }

  async function sshEnv(usePassword) {
    const env = { ...process.env };
    if (!usePassword || !password) return env;
    delete env.SSH_AUTH_SOCK;
    delete env.DISPLAY;
    const dir = await ensureAskpass();
    env.SSH_ASKPASS = join(dir, 'askpass.sh');
    env.SSH_ASKPASS_REQUIRE = 'force';
    return env;
  }

  function destFor(mode) {
    return mode === 'password' ? destination : { ...destination, password: '' };
  }

  async function runAuthenticated(work) {
    const modes = [];
    if (password) modes.push('password');
    else if (hasAgent()) modes.push('agent');
    if (modes.length === 0) modes.push('agent');
    let lastError = '';
    for (const mode of modes) {
      try {
        return await work(mode);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (mode === modes[modes.length - 1]) throw error;
      }
    }
    throw new Error(lastError || 'ssh failed');
  }

  async function exec(command, timeoutMs = 120000, onChunk) {
    const mux = await muxOptions();
    return runAuthenticated(async (mode) => {
      const result = await io.run('ssh', sshArgv(destFor(mode), { command, options: mux }), {
        env: await sshEnv(mode === 'password'),
        timeoutMs,
        onChunk,
        password: mode === 'password' ? password : '',
      });
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || `ssh exited ${result.code}`).trim();
        throw new Error(detail);
      }
      return result.stdout;
    });
  }

  async function push(localPath, remotePath, onChunk) {
    const quoted = shellSingleQuote(remotePath);
    const mux = await muxOptions();
    return runAuthenticated(async (mode) => {
      const stdin = io.readStream
        ? io.readStream(localPath)
        : (await import('node:fs')).createReadStream(localPath);
      const result = await io.run(
        'ssh',
        sshArgv(destFor(mode), {
          command: `mkdir -p "$(dirname -- ${quoted})" && cat > ${quoted}`,
          options: mux,
        }),
        {
          env: await sshEnv(mode === 'password'),
          timeoutMs: 600000,
          onChunk,
          stdin,
          password: mode === 'password' ? password : '',
        }
      );
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || `ssh exited ${result.code}`).trim();
        throw new Error(detail);
      }
    });
  }

  async function forward(remotePort = DEFAULT_REMOTE_PORT) {
    const localPort = await pickLocalPort();
    const mux = await muxOptions();
    const options = [
      ...mux,
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ];
    return runAuthenticated(async (mode) => {
      const child = io.spawn('ssh', sshArgv(destFor(mode), { options }), {
        env: await sshEnv(mode === 'password'),
        password: mode === 'password' ? password : '',
      });
      const session = { localPort, remotePort, child };
      forwards.add(session);
      try {
        await waitForListen(localPort, child, 20000);
      } catch (error) {
        forwards.delete(session);
        await io.kill(child);
        throw error;
      }
      return {
        origin: `http://127.0.0.1:${localPort}`,
        localPort,
        async close() {
          forwards.delete(session);
          await io.kill(child);
        },
      };
    });
  }

  async function close() {
    await Promise.all([...forwards].map((item) => io.kill(item.child)));
    forwards.clear();
    if (controlPath) {
      spawnSync(
        'ssh',
        ['-O', 'exit', '-o', `ControlPath=${controlPath}`, 'exit'],
        { stdio: 'ignore', timeout: 3000 }
      );
      await rm(join(controlPath, '..'), { recursive: true, force: true }).catch(
        () => undefined
      );
      controlPath = undefined;
    }
    if (askpassDir) {
      await rm(askpassDir, { recursive: true, force: true });
      askpassDir = undefined;
    }
  }

  function liveOrigins() {
    return [...forwards]
      .filter(
        (item) => item.child && item.child.exitCode == null && !item.child.killed
      )
      .map((item) => `http://127.0.0.1:${item.localPort}`);
  }

  return { host, user, port, jump, exec, push, forward, liveOrigins, close };
}

export function defaultIo() {
  return {
    run(command, args, options) {
      if (usesPasswordTty(command, options)) {
        return runPasswordTty(command, args, options);
      }
      return runProcess(command, args, options);
    },
    spawn(command, args, options) {
      if (usesPasswordTty(command, options)) {
        return spawnPasswordTty(command, args, options);
      }
      return spawn(command, args, sshSpawnOptions(options.env));
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

function usesPasswordTty(command, options) {
  return (
    Boolean(options?.password) &&
    command === 'ssh' &&
    !options.stdin &&
    process.platform === 'darwin'
  );
}

function passwordTtyCommand(args) {
  if (process.platform === 'darwin') {
    return { command: '/usr/bin/script', args: ['-q', '/dev/null', '/usr/bin/ssh', ...args] };
  }
  return { command: 'ssh', args };
}

function attachPassword(child, password, onChunk) {
  let sent = false;
  const handle = (stream, chunk) => {
    const text = String(chunk).replace(/\u0004/g, '');
    emitChunk(onChunk, stream, redactSecret(text, password));
    if (!sent && /password|passphrase|密码/i.test(text)) {
      sent = true;
      child.stdin.write(`${password}\n`);
    }
  };
  child.stdout?.on('data', (chunk) => handle('stdout', chunk));
  child.stderr?.on('data', (chunk) => handle('stderr', chunk));
}

function spawnPasswordTty(command, args, { env, password }) {
  const wrapped = passwordTtyCommand(args);
  const child = spawn(wrapped.command, wrapped.args, {
    env: { ...env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  });
  attachPassword(child, password, undefined);
  return child;
}

function runPasswordTty(command, args, { env, timeoutMs, onChunk, password }) {
  return new Promise((resolve, reject) => {
    const wrapped = passwordTtyCommand(args);
    const child = spawn(wrapped.command, wrapped.args, {
      env: { ...env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    const handle = (stream, chunk) => {
      const text = String(chunk).replace(/\u0004/g, '');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      emitChunk(onChunk, stream, redactSecret(text, password));
      if (!sent && /password|passphrase|密码/i.test(text)) {
        sent = true;
        child.stdin.write(`${password}\n`);
      }
    };
    child.stdout.on('data', (chunk) => handle('stdout', chunk));
    child.stderr.on('data', (chunk) => handle('stderr', chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const detail = redactSecret(stderr.trim(), password);
      reject(
        new Error(
          detail
            ? `ssh timed out after ${timeoutMs}ms: ${detail}`
            : `ssh timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: redactSecret(stdout, password),
        stderr: redactSecret(stderr, password),
      });
    });
  });
}

function redactSecret(text, password) {
  if (!password) return text;
  return text.split(password).join('********');
}

function sshSpawnOptions(env, { stdin } = {}) {
  return {
    env,
    detached: process.platform !== 'win32',
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function emitChunk(onChunk, stream, text) {
  if (!text || typeof onChunk !== 'function') return;
  onChunk({ stream, text });
}

function runProcess(command, args, { env, timeoutMs, onChunk, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, sshSpawnOptions(env, { stdin }));
    if (stdin) {
      const handleError = (error) => {
        child.kill('SIGKILL');
        reject(error);
      };
      if (typeof stdin.pipe === 'function') {
        stdin.on('error', handleError);
        stdin.pipe(child.stdin);
      } else {
        child.stdin.end(stdin);
      }
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      emitChunk(onChunk, 'stdout', text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      emitChunk(onChunk, 'stderr', text);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const detail = stderr.trim();
      reject(
        new Error(
          detail
            ? `ssh timed out after ${timeoutMs}ms: ${detail}`
            : `ssh timed out after ${timeoutMs}ms`
        )
      );
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

export function sshAgentAvailable(env = process.env) {
  const sock = env.SSH_AUTH_SOCK;
  if (!sock || !existsSync(sock)) return false;
  const result = spawnSync('ssh-add', ['-l'], {
    env,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

export function sessionCacheKey(target, password) {
  const user = String(target.user ?? '').trim();
  const host = String(target.host ?? '').trim();
  const port = Number(target.port ?? 22);
  const secret = password ? String(password) : '';
  const auth = secret
    ? createHash('sha256').update(secret).digest('hex').slice(0, 12)
    : 'agent';
  return `${user}@${host}:${port}:${auth}`;
}

export function secretKey(target) {
  return `ssh:${target.user}@${target.host}:${target.port ?? 22}`;
}

export function nonce() {
  return randomBytes(6).toString('hex');
}
