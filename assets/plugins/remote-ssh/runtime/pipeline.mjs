import { createSshSession, secretKey } from './ssh.mjs';

const INSTALL_URL =
  'https://raw.githubusercontent.com/Xircth/VibeX/master/install.sh';
const REMOTE_PORT = 17891;
const STEPS = ['probe', 'install', 'start', 'tunnel', 'pair', 'save', 'connect'];

export function emptyJob(id) {
  return {
    id,
    status: 'running',
    step: STEPS[0],
    steps: STEPS.map((id) => ({ id, state: 'pending', detail: '' })),
    error: null,
    origin: null,
    profileId: null,
  };
}

export function createPipeline(deps) {
  const sessions = new Map();

  function mark(job, step, state, detail = '') {
    job.step = step;
    const item = job.steps.find((entry) => entry.id === step);
    if (item) {
      item.state = state;
      item.detail = detail;
    }
  }

  async function runStep(job, step, work) {
    mark(job, step, 'running');
    try {
      const detail = (await work()) ?? '';
      mark(job, step, 'done', typeof detail === 'string' ? detail : '');
    } catch (error) {
      mark(job, step, 'failed', error.message);
      throw error;
    }
  }

  async function passwordFor(target, supplied, host) {
    if (supplied) return supplied;
    const stored = await host.call('storage', 'kv.get', {
      key: secretKey(target),
    });
    return typeof stored === 'string' && stored ? stored : '';
  }

  async function openSession(target, host) {
    const key = `${target.user}@${target.host}:${target.port}`;
    const existing = sessions.get(key);
    if (existing) return existing;
    const password = await passwordFor(target, target.password, host);
    const session = (deps.createSession ?? createSshSession)(
      { ...target, password },
      deps.io
    );
    sessions.set(key, session);
    return session;
  }

  async function probe(session) {
    const output = await session.exec(
      'printf \'os=%s\\narch=%s\\n\' "$(uname -s | tr A-Z a-z)" "$(uname -m)"; command -v vibex || true; command -v vibex-server || true; printf \'home=%s\\n\' "$HOME"',
      30000
    );
    const os = /os=(\S+)/.exec(output)?.[1] ?? '';
    const arch = /arch=(\S+)/.exec(output)?.[1] ?? '';
    const hasLauncher = /(^|\n)\/.+\bvibex\b/.test(output) || output.includes('/vibex\n');
    const hasServer = output.includes('vibex-server');
    return { os, arch, installed: hasLauncher || hasServer, raw: output };
  }

  async function install(session) {
    const script = [
      'set -eu',
      'export PATH="$HOME/.local/bin:$PATH"',
      'if command -v vibex >/dev/null 2>&1 || command -v vibex-server >/dev/null 2>&1; then',
      '  printf already-installed\\n',
      '  exit 0',
      'fi',
      `curl -fsSL ${INSTALL_URL} | sh`,
    ].join('\n');
    return session.exec(script, 300000);
  }

  async function start(session, dataDir) {
    const dir = String(dataDir ?? '').trim();
    const script = [
      'set -eu',
      'export PATH="$HOME/.local/bin:$PATH"',
      dir ? `export VIBEX_DATA_DIR='${dir.replace(/'/g, `'\\''`)}'` : '',
      'if curl -fsS --max-time 2 http://127.0.0.1:17891/health >/dev/null 2>&1; then',
      '  printf already-running\\n',
      '  exit 0',
      'fi',
      'bin=$(command -v vibex || command -v vibex-server || true)',
      'if [ -z "$bin" ]; then',
      '  printf \'vibex-server is not installed\\n\' >&2',
      '  exit 1',
      'fi',
      'nohup "$bin" --local --port 17891 >/tmp/vibex-server.log 2>&1 &',
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
      '  if curl -fsS --max-time 2 http://127.0.0.1:17891/health >/dev/null 2>&1; then',
      '    printf started\\n',
      '    exit 0',
      '  fi',
      '  sleep 1',
      'done',
      'printf \'vibex-server did not become healthy\\n\' >&2',
      'tail -n 40 /tmp/vibex-server.log >&2 || true',
      'exit 1',
    ]
      .filter(Boolean)
      .join('\n');
    return session.exec(script, 60000);
  }

  async function readHostToken(session) {
    const output = await session.exec(
      [
        'set -eu',
        'for candidate in \\',
        '  "${VIBEX_DATA_DIR:-}/host.token" \\',
        '  "$HOME/.local/share/vibex/host.token" \\',
        '  "$HOME/.local/share/vibex/VibeX/host.token" \\',
        '  "$HOME/Library/Application Support/app.vibex.vibex/host.token"; do',
        '  if [ -n "$candidate" ] && [ -f "$candidate" ]; then cat "$candidate"; exit 0; fi',
        'done',
        'printf \'host token not found\\n\' >&2',
        'exit 1',
      ].join('\n'),
      15000
    );
    const token = output.trim();
    if (!token) throw new Error('host token was empty');
    return token;
  }

  async function issuePairing(origin, hostToken, fetchImpl) {
    const response = await fetchImpl(`${origin}/api/v1/auth/pairings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${hostToken}`,
        'content-type': 'application/json',
        'x-vibex-protocol-version': '1.0',
      },
      body: JSON.stringify({ preset: 'workstation' }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`pairing failed (${response.status}): ${body.slice(0, 240)}`);
    }
    const payload = await response.json();
    const token = payload.pairing_token || payload.connection_code;
    if (!token) throw new Error('pairing response had no connection code');
    return token;
  }

  async function health(origin, fetchImpl) {
    try {
      const response = await fetchImpl(`${origin}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function runProvision(job, target, host, options = {}) {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const session = await openSession(target, host);
    await runStep(job, 'probe', async () => {
      const seen = await probe(session);
      return `${seen.os}/${seen.arch}`;
    });
    await runStep(job, 'install', () => install(session));
    await runStep(job, 'start', () => start(session, target.dataDir));
    let tunnel;
    await runStep(job, 'tunnel', async () => {
      tunnel = await session.forward(REMOTE_PORT);
      job.origin = tunnel.origin;
      return tunnel.origin;
    });
    let pairingToken = options.pairingToken ?? null;
    if (!options.skipPair) {
      await runStep(job, 'pair', async () => {
        const hostToken = await readHostToken(session);
        pairingToken = await issuePairing(tunnel.origin, hostToken, fetchImpl);
        return 'workstation';
      });
    } else {
      mark(job, 'pair', 'done', 'kept');
    }
    let profile;
    await runStep(job, 'save', async () => {
      const name = `${target.user}@${target.host}`;
      profile = await host.call('remote', 'profile.upsert', {
        id: options.profileId ?? undefined,
        origin: tunnel.origin,
        name,
        provisionKind: 'ssh',
        provision: {
          host: target.host,
          port: target.port,
          user: target.user,
          jump: target.jump || undefined,
          dataDir: target.dataDir || undefined,
        },
      });
      job.profileId = profile.id;
      return name;
    });
    if (!options.skipConnect) {
      await runStep(job, 'connect', async () => {
        const result = await host.call('remote', 'connect', {
          profileId: profile.id,
          origin: tunnel.origin,
          token: pairingToken ?? undefined,
        });
        return result?.profile?.origin ?? tunnel.origin;
      });
    } else {
      mark(job, 'connect', 'done', 'deferred');
    }
    job.status = 'completed';
    job.origin = tunnel.origin;
    if (target.rememberPassword && target.password) {
      await host.call('storage', 'kv.put', {
        key: secretKey(target),
        value: target.password,
      });
    }
    return { origin: tunnel.origin, token: pairingToken, profile };
  }

  async function ensure(input, host) {
    const profile = input.profile ?? {};
    const provision = profile.provision ?? {};
    const target = {
      host: provision.host,
      port: provision.port ?? 22,
      user: provision.user,
      jump: provision.jump ?? '',
      dataDir: provision.dataDir ?? '',
      password: input.password ?? '',
    };
    const origin = String(profile.origin ?? '').trim();
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (origin && (await health(origin, fetchImpl))) {
      return { origin };
    }
    const job = emptyJob('ensure');
    const result = await runProvision(job, target, host, {
      profileId: profile.id,
      skipConnect: true,
      skipPair: Boolean(profile.hasCredential),
    });
    return { origin: result.origin, token: result.token };
  }

  async function dispose() {
    await Promise.all(
      [...sessions.values()].map((session) =>
        session.close?.().catch(() => undefined)
      )
    );
    sessions.clear();
  }

  return { provision: runProvision, ensure, dispose, sessions };
}

export { STEPS };
