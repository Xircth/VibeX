import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANAGED_NODE_VERSION,
  glibcTooOld,
  managedNodeArtifact,
  nodeArchiveName,
  nodeDownloadUrls,
  releaseUrls,
  resolveLatestTag,
  tagFromReleaseUrl,
} from '../runtime/download.mjs';
import { appendJobLog, formatElapsed, sanitizeRemoteOutput } from '../runtime/log.mjs';
import {
  connectableOrigin,
  createPipeline,
  emptyJob,
  execStartPath,
  formatSshHostConfig,
  isPluginManagedInstallPath,
  originAllowsPlaintextHttp,
  parseProbeOutput,
  pickDurableOrigin,
  remoteInstallScript,
  remoteUnpackNodeScript,
  reuseExistingStartScript,
  shouldReuseRemoteServer,
} from '../runtime/pipeline.mjs';
import net from 'node:net';

import {
  askpassProgram,
  askpassScript,
  createSshSession,
  sshAgentAvailable,
  secretKey,
  sessionCacheKey,
  sshArgv,
  sshControlMasterSupported,
  sshTunnelOptions,
  usesPasswordTty,
} from '../runtime/ssh.mjs';
import {
  formatHistoryWhen,
  friendlyError,
  historyIdentity,
  historyRecord,
  historyTitle,
  matchingSavedProfile,
  profileName,
  replaceHistory,
  jobElapsed,
  jobHeadline,
  jobProgress,
  localeBundle,
  stepView,
  upsertHistory,
} from '../runtime/ui.mjs';
import worker from '../runtime/worker.mjs';

function memoryHost() {
  const kv = new Map();
  const calls = [];
  const profiles = [];
  return {
    calls,
    profiles,
    async call(capability, operation, input) {
      calls.push({ capability, operation, input });
      if (capability === 'storage' && operation === 'kv.get') {
        return kv.get(input.key) ?? null;
      }
      if (capability === 'storage' && operation === 'kv.put') {
        kv.set(input.key, input.value);
        return input.value;
      }
      if (capability === 'storage' && operation === 'settings.get') {
        return kv.get('settings') ?? {};
      }
      if (capability === 'storage' && operation === 'settings.put') {
        kv.set('settings', input);
        return input;
      }
      if (capability === 'remote' && operation === 'profile.list') {
        return { profiles };
      }
      if (capability === 'remote' && operation === 'profile.upsert') {
        const profile = {
          id: input.id ?? `profile-${profiles.length + 1}`,
          origin: input.origin,
          name: input.name,
          provisionKind: input.provisionKind,
          provision: input.provision,
          hasCredential: false,
          connected: false,
        };
        const index = profiles.findIndex((item) => item.id === profile.id);
        if (index >= 0) profiles[index] = { ...profiles[index], ...profile };
        else profiles.push(profile);
        return profile;
      }
      if (capability === 'remote' && operation === 'connect') {
        return {
          profile: { ...profiles[0], connected: true, id: input.profileId },
          stoppedHost: true,
        };
      }
      if (capability === 'app' && operation === 'notify.toast') {
        return {};
      }
      throw new Error(`unexpected ${capability}.${operation}`);
    },
  };
}

function fakeSession() {
  const commands = [];
  return {
    commands,
    async exec(command, _timeout, onChunk) {
      commands.push(command);
      let stdout = '';
      if (command.includes('already-running') || command.includes('nohup')) {
        stdout =
          'started\nhttp://127.0.0.1:17891\nhttp://203.0.113.8:17891\n';
      } else if (command.includes('host.token')) {
        stdout = 'host-token-secret\n';
      } else if (command.includes('SHA256SUMS') || command.includes('printf installed')) {
        stdout = 'installed\n';
      } else if (command.includes('uname')) {
        stdout =
          'os=linux\narch=x86_64\nglibc=2.35\nnode=/usr/bin/node\nnpm=/usr/bin/npm\nhome=/root\n';
      }
      onChunk?.({ stream: 'stdout', text: stdout });
      return stdout;
    },
    async push(_localPath, remotePath, onChunk) {
      commands.push(`push ${remotePath}`);
      onChunk?.({ stream: 'stdout', text: `uploaded ${remotePath}\n` });
    },
    async forward() {
      return { origin: 'http://127.0.0.1:41234', localPort: 41234, async close() {} };
    },
    liveOrigins() {
      return [];
    },
    async close() {},
  };
}

test('pickDurableOrigin prefers an advertised Host address over loopback', () => {
  assert.equal(
    pickDurableOrigin(
      ['http://127.0.0.1:17891', 'http://203.0.113.8:17891'],
      '203.0.113.8'
    ),
    'http://203.0.113.8:17891'
  );
  assert.equal(
    pickDurableOrigin([], '203.0.113.8'),
    'http://203.0.113.8:17891'
  );
});

test('ssh host config is a secret-free ssh config file', () => {
  assert.equal(
    formatSshHostConfig('Lab', {
      host: '203.0.113.8',
      user: 'root',
      port: 22,
      jump: 'bastion',
    }),
    [
      '# VibeX Host: Lab',
      'Host lab',
      '  HostName 203.0.113.8',
      '  User root',
      '  Port 22',
      '  ProxyJump bastion',
      '',
    ].join('\n')
  );
});

test('connect origin rejects public plaintext HTTP', () => {
  assert.equal(originAllowsPlaintextHttp('http://127.0.0.1:17891'), true);
  assert.equal(originAllowsPlaintextHttp('http://192.168.1.20:17891'), true);
  assert.equal(originAllowsPlaintextHttp('http://10.0.0.8:17891'), true);
  assert.equal(originAllowsPlaintextHttp('http://studio.local:17891'), true);
  assert.equal(originAllowsPlaintextHttp('http://100.64.1.8:17891'), true);
  assert.equal(originAllowsPlaintextHttp('http://203.0.113.10:443'), false);
  assert.equal(originAllowsPlaintextHttp('http://47.109.140.92:13630'), false);
  assert.equal(connectableOrigin('http://203.0.113.8:17891'), '');
  assert.equal(
    connectableOrigin('http://192.168.1.8:17891'),
    'http://192.168.1.8:17891'
  );
  assert.equal(
    connectableOrigin('https://server.example'),
    'https://server.example'
  );
});

test('every contributed handler is registered', async () => {
  const harness = await createWorkerHarness(worker, { host: memoryHost() });
  assert.deepEqual(harness.handlers.sort(), [
    'provision.ensure',
    'session.cancel',
    'session.history',
    'session.historySave',
    'session.load',
    'session.start',
    'session.status',
    'session.test',
    'surface.createSession',
  ]);
  await harness.dispose();
});

test('plugin-owned askpass works on first connect without a system helper', () => {
  const unix = askpassScript('/usr/bin/node', 'darwin');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /VIBEX_SSH_SECRET/);
  assert.equal(unix.includes('/bin/cat'), false);
  const windows = askpassScript('C:\\Program Files\\nodejs\\node.exe', 'win32');
  assert.match(windows, /^@echo off/);
  assert.match(windows, /C:\\Program Files\\nodejs\\node.exe/);
  assert.equal(
    askpassProgram('/tmp/ask', 'win32'),
    join('/tmp/ask', 'askpass.cmd')
  );
  assert.equal(sshControlMasterSupported('darwin'), true);
  assert.equal(sshControlMasterSupported('linux'), true);
  assert.equal(sshControlMasterSupported('win32'), false);
});

test('password ssh does not wrap macOS ssh in script without a tty', () => {
  assert.equal(
    usesPasswordTty(
      'ssh',
      { password: 'secret' },
      { platform: 'darwin', stdinIsTty: false }
    ),
    false
  );
  assert.equal(
    usesPasswordTty(
      'ssh',
      { password: 'secret' },
      { platform: 'darwin', stdinIsTty: true }
    ),
    true
  );
  assert.equal(
    usesPasswordTty(
      'ssh',
      { password: 'secret' },
      { platform: 'linux', stdinIsTty: true }
    ),
    false
  );
});

test('password ssh skips agent, GSSAPI, and pubkey delays', () => {
  const args = sshArgv({
    host: '203.0.113.8',
    user: 'root',
    port: 22,
    password: 'secret',
  });
  assert.ok(args.includes('GSSAPIAuthentication=no'));
  assert.ok(args.includes('PubkeyAuthentication=no'));
  assert.ok(args.includes('PreferredAuthentications=password,keyboard-interactive'));
  assert.ok(!args.includes('BatchMode=yes'));
});

test('password ssh does not try keys when a password is present', async () => {
  const sock = join(tmpdir(), `ssh-agent-${Date.now()}`);
  await writeFile(sock, '');
  const previous = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = sock;
  const calls = [];
  const io = {
    async run(_command, args, options) {
      calls.push({ args, env: options.env });
      if (args.includes('BatchMode=yes')) {
        return { code: 255, stdout: '', stderr: 'Permission denied (publickey).\n' };
      }
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  try {
    const session = createSshSession(
      { host: '203.0.113.8', user: 'root', port: 22, password: 'p@ss-word' },
      io,
      { agentAvailable: () => true }
    );
    await session.exec('true');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.includes('BatchMode=yes'));
    assert.ok(calls[0].args.includes('PubkeyAuthentication=no'));
    assert.equal(calls[0].env.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(calls[0].env.SSH_AUTH_SOCK, undefined);
    assert.ok(calls[0].env.DISPLAY);
    assert.match(calls[0].env.SSH_ASKPASS, /askpass\.(sh|cmd)$/);
    assert.match(calls[0].env.VIBEX_SSH_SECRET, /secret$/);
    const script = await readFile(calls[0].env.SSH_ASKPASS, 'utf8');
    assert.match(script, /VIBEX_SSH_SECRET/);
    assert.equal(script.includes('p@ss-word'), false);
    await session.close();
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test('stored password is used even when an SSH agent has identities', async () => {
  const sock = join(tmpdir(), `ssh-agent-ok-${Date.now()}`);
  await writeFile(sock, '');
  const previous = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = sock;
  const calls = [];
  const io = {
    async run(_command, args, options) {
      calls.push({ args, env: options.env });
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  try {
    const session = createSshSession(
      { host: '203.0.113.8', user: 'root', port: 22, password: 'p@ss-word' },
      io,
      { agentAvailable: () => true }
    );
    assert.equal(await session.exec('true'), 'ok\n');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('PubkeyAuthentication=no'));
    assert.equal(calls[0].env.SSH_ASKPASS_REQUIRE, 'force');
    await session.close();
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test('password-only login skips publickey when no agent is present', async () => {
  const previous = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  const calls = [];
  const io = {
    async run(_command, args, options) {
      calls.push({ args, env: options.env });
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  try {
    assert.equal(sshAgentAvailable({ SSH_AUTH_SOCK: '' }), false);
    const session = createSshSession(
      { host: '203.0.113.8', user: 'root', port: 22, password: 'p@ss-word' },
      io,
      { agentAvailable: () => false }
    );
    assert.equal(await session.exec('true'), 'ok\n');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('PubkeyAuthentication=no'));
    assert.equal(calls[0].env.SSH_ASKPASS_REQUIRE, 'force');
    await session.close();
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
  }
});

test('ssh argv puts the destination before a remote command', () => {
  const command = "printf 'os=%s\\n' \"$(uname -s)\"";
  const args = sshArgv(
    { host: '203.0.113.8', user: 'root', port: 22, password: 'secret' },
    { command }
  );
  assert.deepEqual(args.slice(-3), ['--', 'root@203.0.113.8', command]);
  assert.ok(args.indexOf(command) > args.indexOf('root@203.0.113.8'));
});

test('ssh argv keeps local-forward options before the destination', () => {
  const args = sshArgv(
    { host: '203.0.113.8', user: 'root', port: 22 },
    {
      options: ['-N', '-L', '127.0.0.1:41234:127.0.0.1:17891'],
    }
  );
  const destination = args.indexOf('--');
  assert.ok(args.indexOf('-N') < destination);
  assert.ok(args.indexOf('-L') < destination);
  assert.deepEqual(args.slice(destination), ['--', 'root@203.0.113.8']);
});

test('ssh tunnel argv is a dedicated -n -N forward, not a ControlMaster slave', () => {
  const args = sshArgv(
    { host: '203.0.113.8', user: 'root', port: 22, password: 'secret' },
    { options: sshTunnelOptions(41234, 17891) }
  );
  const destination = args.indexOf('--');
  assert.ok(args.indexOf('-n') < destination);
  assert.ok(args.indexOf('-N') < destination);
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('ControlMaster=no'));
  assert.ok(args.includes('127.0.0.1:41234:127.0.0.1:17891'));
  assert.equal(
    args.some((value) => String(value).startsWith('ControlPath=')),
    false
  );
  assert.equal(
    args.some((value) => String(value).includes('ControlPersist')),
    false
  );
  assert.deepEqual(args.slice(destination), ['--', 'root@203.0.113.8']);
});

test('ssh tunnel spawn does not reuse the exec ControlMaster', async () => {
  const calls = [];
  let listener;
  const io = {
    async run() {
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    spawn(_command, args, options) {
      calls.push({ args, options });
      const spec = args.find((value) =>
        /^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/.test(String(value))
      );
      const localPort = Number(String(spec).split(':')[1]);
      const child = {
        exitCode: null,
        killed: false,
        stderr: { on() {} },
        kill() {
          this.killed = true;
          this.exitCode = 1;
        },
      };
      listener = net.createServer();
      listener.unref();
      listener.listen(localPort, '127.0.0.1');
      return child;
    },
    async kill(child) {
      child?.kill();
      await new Promise((resolve) => listener?.close(resolve));
      listener = undefined;
    },
  };
  const session = createSshSession(
    { host: '203.0.113.8', user: 'root', port: 22, password: 'secret' },
    io
  );
  const tunnel = await session.forward(17891);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('-n'));
  assert.ok(calls[0].args.includes('-N'));
  assert.ok(calls[0].args.includes('ControlMaster=no'));
  assert.equal(
    calls[0].args.some((value) => String(value).startsWith('ControlPath=')),
    false
  );
  assert.match(tunnel.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  await tunnel.close();
});

test('ssh tunnel that exits before listen is an error', async () => {
  const io = {
    async run() {
      return { code: 0, stdout: '', stderr: '' };
    },
    spawn() {
      return {
        exitCode: 0,
        killed: false,
        stderr: { on() {} },
        kill() {},
      };
    },
    async kill() {},
  };
  const session = createSshSession(
    { host: '203.0.113.8', user: 'root', port: 22 },
    io
  );
  await assert.rejects(
    () => session.forward(17891),
    /tunnel closed before|tunnel exited 0/
  );
  await session.close();
});

test('ssh exec passes the remote script after the destination', async () => {
  const calls = [];
  const io = {
    async run(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  const session = createSshSession(
    { host: '203.0.113.8', user: 'root', port: 22 },
    io
  );
  const remote = "printf 'os=%s\\n' \"$(uname -s)\"";
  await session.exec(remote);
  assert.equal(calls[0].command, 'ssh');
  assert.deepEqual(calls[0].args.slice(-3), [
    '--',
    'root@203.0.113.8',
    remote,
  ]);
  await session.close();
});

test('session.start reads the App invoke payload, not a Host envelope', async () => {
  const harness = await createWorkerHarness(worker, { host: memoryHost() });
  await assert.rejects(
    () => harness.invoke('session.start', {}),
    /host and user are required/
  );
  await assert.rejects(
    () =>
      harness.invoke('session.start', {
        params: { host: '203.0.113.8', user: 'root' },
      }),
    /host and user are required/
  );
  await harness.dispose();
});

test('install ships the Host family script instead of curling GitHub raw', () => {
  const script = remoteInstallScript();
  const executable = script.replace(/#[^\n]*/g, '');
  assert.match(script, /write_launcher/);
  assert.match(script, /github\.com\/\$\{REPO\}\/releases\/download/);
  assert.equal(/\|\s*sh/.test(executable), false);
  assert.equal(script.includes('--progress-bar'), false);
  assert.match(script, /curl -4 -fL --http1\.1/);
  assert.match(script, /the vibex launcher is missing/);
  assert.match(script, /--speed-limit 1024 --speed-time 15/);
  assert.match(script, /ghfast\.top/);
  assert.match(script, /downloaded %\{size_download\} bytes/);
  assert.match(script, /vibex-server" serve/);
  assert.match(script, /printf 'already-installed\\n'/);
});

test('glibc older than 2.34 is rejected before install', async () => {
  assert.equal(glibcTooOld('2.28'), true);
  assert.equal(glibcTooOld('2.34'), false);
  assert.match(
    friendlyError('GLIBC_2.28 is too old; Linux Host needs glibc 2.34+', true),
    /Ubuntu 22\.04/
  );
  assert.match(
    friendlyError('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', true),
    /不是密码问题/
  );
  const session = fakeSession();
  const inner = session.exec.bind(session);
  session.exec = async (command, timeout, onChunk) => {
    if (String(command).includes('uname')) {
      const stdout = 'os=linux\narch=x86_64\nglibc=2.17\nhome=/root\n';
      onChunk?.({ stream: 'stdout', text: stdout });
      return stdout;
    }
    return inner(command, timeout, onChunk);
  };
  const pipeline = createPipeline({
    createSession: () => session,
    fetchImpl: async () => {
      throw new Error('must not download');
    },
  });
  await assert.rejects(
    () =>
      pipeline.provision(
        emptyJob('old-glibc'),
        { host: '203.0.113.8', port: 22, user: 'root' },
        memoryHost()
      ),
    /GLIBC_2\.17 is too old/
  );
  await pipeline.dispose();
});

test('existing source-built Hosts are reused instead of overwritten', () => {
  assert.equal(
    isPluginManagedInstallPath(
      '/root/.vibex/host-family/v0.2.1/linux-x86_64/family/vibex-server'
    ),
    true
  );
  assert.equal(isPluginManagedInstallPath('/root/.local/bin/vibex'), true);
  assert.equal(
    isPluginManagedInstallPath('/opt/VibeX/target/debug/vibex-server'),
    false
  );
  assert.equal(
    execStartPath(
      '{ path=/opt/VibeX/target/debug/vibex-server ; argv[]=/opt/VibeX/target/debug/vibex-server serve --port 17891 ; }'
    ),
    '/opt/VibeX/target/debug/vibex-server'
  );
  const running = parseProbeOutput(
    [
      'os=linux',
      'arch=x86_64',
      'glibc=2.35',
      '/root/.local/bin/vibex',
      'home=/root',
      'health={"status":"ok","version":"0.2.1"}',
      'exe=/opt/VibeX/target/debug/vibex-server',
      'execstart={ path=/opt/VibeX/target/debug/vibex-server ; argv[]=/opt/VibeX/target/debug/vibex-server serve --port 17891 ; }',
      '',
    ].join('\n')
  );
  assert.equal(running.running, true);
  assert.equal(running.exe, '/opt/VibeX/target/debug/vibex-server');
  assert.equal(shouldReuseRemoteServer(running), true);
  assert.equal(
    shouldReuseRemoteServer({
      running: false,
      exe: '',
      execStart:
        '{ path=/root/.vibex/host-family/v0.2.1/linux-x86_64/family/vibex-server ; }',
    }),
    false
  );
  const reuse = reuseExistingStartScript('');
  assert.match(reuse, /printf 'already-running\\n'/);
  assert.equal(reuse.includes('write_unit'), false);
  assert.equal(reuse.includes('cat > "$unit_path"'), false);
});

test('pinned Node catalog matches the Host bootstrap toolchain', () => {
  assert.equal(MANAGED_NODE_VERSION, '22.22.3');
  for (const platform of [
    'linux-x86_64',
    'linux-aarch64',
    'darwin-aarch64',
    'windows-x86_64',
  ]) {
    const artifact = managedNodeArtifact(platform);
    assert.equal(artifact.sha256.length, 64);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(managedNodeArtifact('linux-x86_64').target, 'linux-x64');
  assert.equal(
    nodeArchiveName('linux-x86_64'),
    `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`
  );
  assert.equal(
    nodeDownloadUrls('linux-x86_64')[0],
    `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`
  );
  assert.equal(
    nodeDownloadUrls('linux-x86_64').some((url) => url.includes('npmmirror.com')),
    true
  );
});

test('probe without node/npm is treated as missing the user toolchain', () => {
  const seen = parseProbeOutput(
    'os=linux\narch=x86_64\nglibc=2.35\nnode=\nnpm=\nhome=/root\n'
  );
  assert.equal(seen.hasNode, false);
  const present = parseProbeOutput(
    'os=linux\narch=x86_64\nglibc=2.35\nnode=/usr/bin/node\nnpm=/usr/bin/npm\nhome=/root\n'
  );
  assert.equal(present.hasNode, true);
});

test('remote Node unpack writes user-environment shims', () => {
  const script = remoteUnpackNodeScript(
    '/tmp/node-v22.22.3-linux-x64.tar.gz',
    'linux-x86_64'
  );
  assert.match(script, /agent-tools\/node\/22\.22\.3\/linux-x86_64/);
  assert.match(script, /write_shim node/);
  assert.match(script, /write_shim npm/);
  assert.match(script, /VibeX toolchain/);
  assert.match(script, /\$HOME\/\.local\/bin/);
});

test('provision keeps a source-built remote Host that is already running', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const inner = session.exec.bind(session);
  session.exec = async (command, timeout, onChunk) => {
    if (String(command).includes('uname')) {
      const stdout = [
        'os=linux',
        'arch=x86_64',
        'glibc=2.35',
        '/root/.local/bin/vibex',
        'node=/usr/bin/node',
        'npm=/usr/bin/npm',
        'home=/root',
        'health={"status":"ok","version":"0.2.1"}',
        'exe=/opt/VibeX/target/debug/vibex-server',
        'execstart={ path=/opt/VibeX/target/debug/vibex-server ; argv[]=/opt/VibeX/target/debug/vibex-server serve --port 17891 ; }',
        '',
      ].join('\n');
      onChunk?.({ stream: 'stdout', text: stdout });
      return stdout;
    }
    return inner(command, timeout, onChunk);
  };
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/auth/pairings') && init.method === 'POST') {
        return {
          ok: true,
          async json() {
            return { pairing_token: 'K7M2NPQX' };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const job = emptyJob('keep-existing');
  const result = await pipeline.provision(
    job,
    { host: '203.0.113.8', port: 22, user: 'root' },
    host
  );
  assert.equal(result.origin, 'http://127.0.0.1:41234');
  assert.equal(
    job.steps.find((step) => step.id === 'install')?.detail,
    'kept existing Host'
  );
  assert.equal(
    session.commands.some((command) => String(command).startsWith('push ')),
    false
  );
  const startScript = session.commands.find((command) =>
    String(command).includes('already-running')
  );
  assert.match(String(startScript), /printf 'already-running\\n'/);
  assert.equal(String(startScript).includes('write_unit'), false);
  assert.equal(String(startScript).includes('cat > "$unit_path"'), false);
  await pipeline.dispose();
});

test('provision installs Node.js when the remote has no node or npm', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const inner = session.exec.bind(session);
  session.exec = async (command, timeout, onChunk) => {
    if (String(command).includes('uname')) {
      const stdout = [
        'os=linux',
        'arch=x86_64',
        'glibc=2.35',
        'node=',
        'npm=',
        'home=/root',
        '',
      ].join('\n');
      onChunk?.({ stream: 'stdout', text: stdout });
      return stdout;
    }
    return inner(command, timeout, onChunk);
  };
  const nodeDownloads = [];
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async ({ dest }) => {
      await writeFile(dest, 'host-family');
    },
    downloadNode: async ({ platform, dest }) => {
      nodeDownloads.push(platform);
      await writeFile(dest, 'node-archive');
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('/releases/latest')) {
        return {
          ok: true,
          url: 'https://github.com/Xircth/VibeX/releases/tag/v0.2.1',
          headers: {
            get: (name) =>
              name.toLowerCase() === 'location'
                ? 'https://github.com/Xircth/VibeX/releases/tag/v0.2.1'
                : '',
          },
        };
      }
      if (String(url).endsWith('/auth/pairings') && init.method === 'POST') {
        return {
          ok: true,
          async json() {
            return { pairing_token: 'K7M2NPQX' };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const job = emptyJob('install-node');
  await pipeline.provision(
    job,
    { host: '203.0.113.8', port: 22, user: 'root' },
    host
  );
  assert.deepEqual(nodeDownloads, ['linux-x86_64']);
  assert.equal(
    session.commands.some((command) =>
      String(command).includes('VibeX toolchain')
    ),
    true
  );
  const unit = session.commands.find((command) =>
    String(command).includes('write_unit')
  );
  assert.match(String(unit), /Environment=PATH=\$HOME\/\.local\/bin:/);
  await pipeline.dispose();
});

test('latest tag follows the GitHub release page when the API returns 403', async () => {
  assert.equal(
    tagFromReleaseUrl('https://github.com/Xircth/VibeX/releases/tag/v0.2.0'),
    'v0.2.0'
  );
  const tag = await resolveLatestTag('Xircth/VibeX', {
    fetchImpl: async (url) => {
      if (String(url).includes('api.github.com')) {
        return { ok: false, status: 403, headers: { get: () => '' } };
      }
      return {
        ok: true,
        status: 302,
        url: 'https://github.com/Xircth/VibeX/releases/tag/v0.2.0',
        headers: {
          get: (name) =>
            String(name).toLowerCase() === 'location'
              ? 'https://github.com/Xircth/VibeX/releases/tag/v0.2.0'
              : '',
        },
      };
    },
  });
  assert.equal(tag, 'v0.2.0');
});

test('release urls try GitHub then download mirrors', () => {
  const urls = releaseUrls(
    'https://github.com/Xircth/VibeX/releases/download/v0.2.0/VibeX-0.2.0-linux-x86_64-server.tar.gz'
  );
  assert.equal(urls[0].startsWith('https://github.com/'), true);
  assert.equal(urls.some((url) => url.includes('ghfast.top')), true);
});

test('remote output strips curl meters and keeps real lines', () => {
  assert.deepEqual(
    sanitizeRemoteOutput('#=#=#                                                          \rDownloading VibeX Host family v0.2.0 for linux-x86_64...\n\x1b[32mok\x1b[0m\r'),
    ['Downloading VibeX Host family v0.2.0 for linux-x86_64...', 'ok']
  );
});

test('job log keeps live detail on the running step and caps length', () => {
  const job = emptyJob('log-1');
  job.steps[1].state = 'running';
  job.step = 'install';
  appendJobLog(job, 'Downloading archive (attempt 1/5)\n');
  assert.equal(job.steps[1].detail, 'Downloading archive (attempt 1/5)');
  assert.equal(job.log.at(-1).step, 'install');
  for (let index = 0; index < 400; index += 1) {
    appendJobLog(job, `line-${index}\n`);
  }
  assert.equal(job.log.length, 300);
  assert.equal(job.log[0].text, 'line-100');
});

test('progress follows completed steps and history can keep a password', () => {
  const running = emptyJob('progress-1');
  running.steps[0].state = 'done';
  running.steps[1].state = 'running';
  running.step = 'install';
  const percent = jobProgress(running);
  assert.equal(percent >= 20 && percent < 100, true);
  running.status = 'completed';
  assert.equal(jobProgress(running), 100);

  const first = historyRecord(
    { host: '203.0.113.8', port: 22, user: 'root', password: 'secret' },
    'failed'
  );
  assert.equal(first.password, 'secret');
  const next = upsertHistory(
    [first],
    historyRecord(
      { host: '203.0.113.8', port: 22, user: 'root', jump: '' },
      'completed'
    )
  );
  assert.equal(next.length, 1);
  assert.equal(next[0].status, 'completed');
  assert.equal(historyIdentity(next[0]), 'root@203.0.113.8');
  assert.equal(profileName({ user: 'root', host: '203.0.113.8' }), 'root@203.0.113.8');
  assert.equal(
    profileName({ name: 'Lab', user: 'root', host: '203.0.113.8' }),
    'Lab'
  );
  assert.equal(
    historyTitle({ name: 'Lab', user: 'root', host: '203.0.113.8' }),
    'Lab'
  );
  assert.equal(formatHistoryWhen(Date.now(), Date.now(), true), '刚刚');
});

test('headlines describe the live step instead of a generic connecting label', () => {
  const bundle = localeBundle('zh-CN');
  const job = emptyJob('head-1');
  job.step = 'install';
  job.steps[1].state = 'running';
  job.startedAt = 1_000;
  assert.equal(jobHeadline(job, bundle), '正在下载并安装 Host family');
  assert.equal(jobElapsed(job, 13_000), '12s');
  job.status = 'completed';
  job.origin = 'http://127.0.0.1:41234';
  assert.equal(jobHeadline(job, bundle), '已接入 127.0.0.1:41234');
  assert.match(
    friendlyError('Permission denied (publickey,password)', true),
    /用户名大小写/
  );
  assert.equal(formatElapsed(125000), '2m 5s');
  const steps = stepView(job, bundle);
  assert.equal(steps.find((step) => step.id === 'install')?.stateLabel, '进行中');
  assert.equal(steps.find((step) => step.id === 'probe')?.stateLabel, '');
});

test('ssh push pipes the local archive through ssh stdin', async () => {
  let stdin;
  const io = {
    async run(_command, args, options) {
      stdin = options.stdin;
      return { code: 0, stdout: '', stderr: '' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'vibex-push-'));
  const localPath = join(dir, 'family.tar.gz');
  await writeFile(localPath, 'archive');
  const session = createSshSession(
    { host: '203.0.113.8', user: 'root', port: 22 },
    io
  );
  await session.push(localPath, '/tmp/family.tar.gz');
  assert.equal(typeof stdin.pipe, 'function');
  stdin.destroy?.();
  await session.close();
});

test('ssh exec forwards live chunks to the caller', async () => {
  const chunks = [];
  const io = {
    async run(_command, _args, options) {
      options.onChunk?.({ stream: 'stdout', text: 'Downloading…\n' });
      options.onChunk?.({ stream: 'stderr', text: 'retry 2/5\n' });
      return { code: 0, stdout: 'Downloading…\n', stderr: 'retry 2/5\n' };
    },
    spawn() {
      throw new Error('spawn is unused');
    },
    async kill() {},
  };
  const session = createSshSession(
    { host: '203.0.113.8', user: 'root', port: 22 },
    io
  );
  await session.exec('true', 1000, (chunk) => chunks.push(chunk));
  assert.deepEqual(chunks, [
    { stream: 'stdout', text: 'Downloading…\n' },
    { stream: 'stderr', text: 'retry 2/5\n' },
  ]);
  await session.close();
});

test('provision upserts an ssh Host and asks the Host to connect', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const dataDir = await mkdtemp(join(tmpdir(), 'vibex-hosts-'));
  const previousDataDir = process.env.VIBEX_SSH_HOST_FILES_DIR;
  process.env.VIBEX_SSH_HOST_FILES_DIR = dataDir;
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async ({ dest, onChunk }) => {
      onChunk?.({
        stream: 'stdout',
        text: 'Downloading VibeX Host family v0.2.0\n',
      });
      await writeFile(dest, 'fake-archive');
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { tag_name: 'v0.2.0' };
          },
        };
      }
      if (String(url).endsWith('/auth/pairings') && init.method === 'POST') {
        return {
          ok: true,
          async json() {
            return { pairing_token: 'K7M2NPQX' };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const job = emptyJob('job-1');
  const result = await pipeline.provision(
    job,
    {
      name: 'Lab',
      host: '203.0.113.8',
      port: 22,
      user: 'root',
      password: 'secret',
      rememberPassword: true,
    },
    host
  );
  assert.equal(result.origin, 'http://127.0.0.1:41234');
  assert.equal(result.token, 'K7M2NPQX');
  assert.equal(host.profiles[0].origin, 'http://203.0.113.8:17891');
  assert.equal(host.profiles[0].provisionKind, 'ssh');
  assert.equal(host.profiles[0].name, 'Lab');
  assert.equal(host.profiles[0].provision.host, '203.0.113.8');
  const connectCall = host.calls.find(
    (call) => call.capability === 'remote' && call.operation === 'connect'
  );
  assert.equal(connectCall?.input.origin, 'http://127.0.0.1:41234');
  assert.equal(host.calls.some((call) => call.operation === 'profile.forget'), false);
  assert.equal(job.status, 'completed');
  assert.equal(
    job.log.some((entry) => entry.text.includes('Downloading VibeX Host family')),
    true
  );
  assert.equal(job.steps.find((step) => step.id === 'install')?.detail, 'installed');
  assert.equal(
    session.commands.some((command) => String(command).startsWith('push ')),
    true
  );
  assert.equal(
    session.commands.some((command) => String(command).includes('serve --port 17891')),
    true
  );
  assert.equal(
    session.commands.some((command) =>
      String(command).includes("printf 'installed\\n'")
    ),
    true
  );
  const startScript = session.commands.find((command) =>
    String(command).includes('already-running')
  );
  assert.match(String(startScript), /printf 'already-running\\n'/);
  assert.match(String(startScript), /printf 'started\\n'/);
  assert.equal(host.profiles[0].provision.servicePort, 17891);
  assert.deepEqual(host.profiles[0].provision.addresses, [
    'http://127.0.0.1:17891',
    'http://203.0.113.8:17891',
  ]);
  assert.equal(
    session.commands.some((command) => String(command).includes('Restart=always')),
    true
  );
  assert.equal(
    session.commands.some((command) => String(command).includes('RUST_LOG=error')),
    false
  );
  const hostFile = await readFile(
    join(dataDir, `${result.profile.id}.sshconfig`),
    'utf8'
  );
  assert.match(hostFile, /HostName 203.0.113.8/);
  assert.equal(hostFile.includes('secret'), false);
  if (previousDataDir === undefined) delete process.env.VIBEX_SSH_HOST_FILES_DIR;
  else process.env.VIBEX_SSH_HOST_FILES_DIR = previousDataDir;
  await pipeline.dispose();
});

test('session history returns stored configs and never a connect action', async () => {
  const host = memoryHost();
  await host.call('storage', 'kv.put', {
    key: 'config:history',
    value: [
      historyRecord(
        { host: '203.0.113.8', port: 22, user: 'root', jump: '' },
        'completed',
        1
      ),
    ],
  });
  const harness = await createWorkerHarness(worker, { host });
  const history = await harness.invoke('session.history', {});
  assert.equal(Array.isArray(history), true);
  assert.equal(history[0].host, '203.0.113.8');
  assert.equal(history[0].user, 'root');
  assert.equal(history[0].password, '');
  await harness.dispose();
});

test('testing SSH only probes login and does not save or connect a Host', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
  });
  const result = await pipeline.testLogin(
    { host: '203.0.113.8', port: 22, user: 'root', password: 'secret' },
    host
  );
  assert.equal(result.ok, true);
  assert.equal(
    session.commands.some((command) => String(command).includes('uname')),
    true
  );
  assert.equal(
    host.calls.some((call) => call.capability === 'remote'),
    false
  );
  await pipeline.dispose();
});

test('saving history updates SSH login and the matching saved Host', async () => {
  const host = memoryHost();
  host.profiles.push({
    id: 'kept',
    origin: 'http://127.0.0.1:41234',
    name: 'Lab',
    provisionKind: 'ssh',
    provision: { host: '203.0.113.8', port: 22, user: 'root' },
  });
  await host.call('storage', 'kv.put', {
    key: 'config:history',
    value: [
      historyRecord(
        {
          name: 'Lab',
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          password: 'old-secret',
          profileId: 'kept',
          origin: 'http://127.0.0.1:41234',
        },
        'completed',
        1
      ),
    ],
  });
  const harness = await createWorkerHarness(worker, { host });
  const history = await harness.invoke('session.historySave', {
    index: 0,
    name: 'Lab',
    host: '203.0.113.8',
    port: 22,
    user: 'root',
    password: 'new-secret',
    jump: '',
  });
  assert.equal(history[0].password, 'new-secret');
  assert.equal(
    await host.call('storage', 'kv.get', {
      key: 'ssh:root@203.0.113.8:22',
    }),
    'new-secret'
  );
  assert.equal(host.profiles[0].provision.user, 'root');
  assert.equal(host.profiles[0].provision.host, '203.0.113.8');
  assert.equal(
    matchingSavedProfile(host.profiles, history[0]).id,
    'kept'
  );
  assert.equal(
    replaceHistory(
      history,
      0,
      historyRecord(
        { ...history[0], user: 'deploy' },
        'completed'
      )
    )[0].user,
    'deploy'
  );
  await harness.dispose();
});

test('ensure uses a password from connection history when kv is empty', async () => {
  const host = memoryHost();
  await host.call('storage', 'kv.put', {
    key: 'config:history',
    value: [
      historyRecord(
        {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          password: 'from-history',
        },
        'completed'
      ),
    ],
  });
  let usedPassword = '';
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: (target) => {
      usedPassword = String(target.password ?? '');
      return session;
    },
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/health')) {
        const started = session.commands.some(
          (command) =>
            String(command).includes('serve --port 17891') ||
            String(command).includes('nohup') ||
            String(command).includes('already-running')
        );
        return { ok: started };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        origin: 'http://127.0.0.1:9',
        provision: { host: '203.0.113.8', port: 22, user: 'root' },
      },
    },
    host
  );
  assert.equal(usedPassword, 'from-history');
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  await pipeline.dispose();
});

test('ensure reuses a live local tunnel without opening SSH again', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('127.0.0.1:41234/health')) {
        return { ok: true };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        name: 'Lab',
        origin: 'http://127.0.0.1:41234',
        hasCredential: true,
        provision: {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          addresses: ['http://127.0.0.1:17891', 'http://203.0.113.8:17891'],
        },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  assert.equal(session.commands.length, 0);
  await pipeline.dispose();
});

test('ensure reuses a live tunnel when the saved origin is not loopback', async () => {
  const host = memoryHost();
  const session = fakeSession();
  session.liveOrigins = () => ['http://127.0.0.1:56001'];
  let created = 0;
  const pipeline = createPipeline({
    createSession: () => {
      created += 1;
      return session;
    },
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('127.0.0.1:56001/health')) {
        return { ok: true };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  pipeline.sessions.set(
    sessionCacheKey(
      { user: 'root', host: '203.0.113.8', port: 22 },
      'secret'
    ),
    session
  );
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        name: 'Lab',
        origin: 'http://203.0.113.8:17891',
        hasCredential: true,
        provision: { host: '203.0.113.8', port: 22, user: 'root' },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:56001');
  assert.equal(created, 0);
  assert.equal(session.commands.length, 0);
  await pipeline.dispose();
});

test('ensure drops a stale SSH session and reconnects with the stored password', async () => {
  const host = memoryHost();
  await host.call('storage', 'kv.put', {
    key: secretKey({ user: 'root', host: '203.0.113.8', port: 22 }),
    value: 'secret',
  });
  const stale = fakeSession();
  let closed = false;
  stale.close = async () => {
    closed = true;
  };
  stale.liveOrigins = () => [];
  let usedPassword = '';
  const fresh = fakeSession();
  const pipeline = createPipeline({
    createSession: (target) => {
      usedPassword = String(target.password ?? '');
      return fresh;
    },
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('203.0.113.8:17891/health')) {
        return { ok: true };
      }
      if (String(url).includes('/health')) {
        const started = fresh.commands.some((command) =>
          String(command).includes('serve --port 17891')
        );
        return { ok: started };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  pipeline.sessions.set(
    sessionCacheKey(
      { user: 'root', host: '203.0.113.8', port: 22 },
      'secret'
    ),
    stale
  );
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        origin: 'http://203.0.113.8:17891',
        hasCredential: true,
        provision: { host: '203.0.113.8', port: 22, user: 'root' },
      },
    },
    host
  );
  assert.equal(closed, true);
  assert.equal(usedPassword, 'secret');
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  await pipeline.dispose();
});

test('ensure opens a tunnel when the advertised address is public HTTP', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('203.0.113.8:17891/health')) {
        return { ok: true };
      }
      if (String(url).includes('/health')) {
        const started = session.commands.some((command) =>
          String(command).includes('serve --port 17891')
        );
        return { ok: started };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        name: 'Lab',
        origin: 'http://203.0.113.8:17891',
        hasCredential: true,
        provision: {
          host: '203.0.113.8',
          port: 22,
          user: 'root',
          addresses: ['http://127.0.0.1:17891', 'http://203.0.113.8:17891'],
        },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  assert.equal(session.commands.length > 0, true);
  await pipeline.dispose();
});

test('ensure opens a tunnel instead of connecting to an advertised LAN address', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('192.168.1.8:17891/health')) {
        return { ok: true };
      }
      if (String(url).includes('/health')) {
        const started = session.commands.some((command) =>
          String(command).includes('serve --port 17891')
        );
        return { ok: started };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        origin: 'http://192.168.1.8:17891',
        hasCredential: true,
        provision: {
          host: '192.168.1.8',
          port: 22,
          user: 'root',
          addresses: ['http://127.0.0.1:17891', 'http://192.168.1.8:17891'],
        },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  assert.equal(session.commands.length > 0, true);
  await pipeline.dispose();
});

test('ensure starts the remote Host when the advertised address is down', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async () => {
      throw new Error('install must not run');
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/health')) {
        const started = session.commands.some((command) =>
          String(command).includes('serve --port 17891')
        );
        return { ok: started };
      }
      throw new Error('pairing must not run');
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        origin: 'http://127.0.0.1:1',
        hasCredential: true,
        provision: { host: '203.0.113.8', port: 22, user: 'root' },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  assert.equal(
    host.calls.some((call) => call.operation === 'profile.forget'),
    false
  );
  assert.equal(
    session.commands.some((command) =>
      String(command).includes('serve --port 17891')
    ),
    true
  );
  await pipeline.dispose();
});

test('cancel of an unrelated job keeps the connected SSH tunnel', async () => {
  const host = memoryHost();
  let closed = 0;
  const session = fakeSession();
  session.close = async () => {
    closed += 1;
  };
  const pipeline = createPipeline({
    createSession: () => session,
    downloadRelease: async ({ dest }) => {
      await writeFile(dest, 'fake-archive');
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { tag_name: 'v0.2.0' };
          },
        };
      }
      if (String(url).endsWith('/auth/pairings') && init.method === 'POST') {
        return {
          ok: true,
          async json() {
            return { pairing_token: 'K7M2NPQX' };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const job = emptyJob('job-1');
  await pipeline.provision(
    job,
    { host: '203.0.113.8', port: 22, user: 'root', password: 'secret' },
    host
  );
  await pipeline.cancel({
    id: 'other',
    sessionKey: job.sessionKey,
  });
  assert.equal(closed, 0);
  assert.equal(
    host.calls.some((call) => call.capability === 'remote' && call.operation === 'connect'),
    true
  );
  await pipeline.dispose();
  assert.equal(closed, 1);
});

test('disposing the worker does not forget Hosts', async () => {
  const host = memoryHost();
  const harness = await createWorkerHarness(worker, { host });
  await harness.dispose();
  assert.equal(
    host.calls.some((call) => call.capability === 'remote' && call.operation === 'profile.forget'),
    false
  );
});
