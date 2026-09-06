import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_REPO,
  downloadFirstOk,
  glibcTooOld,
  platformFromProbe,
  resolveLatestTag,
  verifySidecar,
} from './download.mjs';
import { appendJobLog } from './log.mjs';
import { createSshSession, secretKey, sessionCacheKey } from './ssh.mjs';
import {
  HISTORY_KEY,
  profileName,
  sameHistoryTarget,
} from './ui.mjs';

const REMOTE_PORT = 17891;
const STEPS = ['probe', 'install', 'start', 'tunnel', 'pair', 'save', 'connect'];

export function isLoopbackOrigin(origin) {
  return /127\.0\.0\.1|localhost|\[::1\]/i.test(String(origin ?? ''));
}

export function pickDurableOrigin(addresses, sshHost, servicePort = REMOTE_PORT) {
  const list = Array.isArray(addresses) ? addresses : [];
  for (const address of list) {
    const value = String(address ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (value && !isLoopbackOrigin(value)) return value;
  }
  const host = String(sshHost ?? '').trim();
  if (host && !isLoopbackOrigin(host)) {
    return `http://${host}:${servicePort}`;
  }
  const fallback = list.find((item) => String(item ?? '').trim());
  return fallback ? String(fallback).trim().replace(/\/+$/, '') : '';
}

export function emptyJob(id) {
  const now = Date.now();
  return {
    id,
    status: 'running',
    step: STEPS[0],
    steps: STEPS.map((id) => ({ id, state: 'pending', detail: '' })),
    log: [],
    error: null,
    origin: null,
    profileId: null,
    startedAt: now,
    updatedAt: now,
  };
}

export function createPipeline(deps) {
  const sessions = new Map();
  const jobSessions = new Map();

  function mark(job, step, state, detail = '') {
    job.step = step;
    job.updatedAt = Date.now();
    const item = job.steps.find((entry) => entry.id === step);
    if (item) {
      item.state = state;
      item.detail = detail;
    }
  }

  function stream(job, step) {
    return (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk?.text;
      if (!text) return;
      appendJobLog(job, text, {
        step,
        stream: typeof chunk === 'object' ? chunk.stream ?? 'stdout' : 'stdout',
      });
    };
  }

  async function runStep(job, step, work) {
    mark(job, step, 'running');
    try {
      const detail = (await work(stream(job, step))) ?? '';
      mark(job, step, 'done', typeof detail === 'string' ? detail : '');
    } catch (error) {
      appendJobLog(job, error.message, { step, stream: 'stderr' });
      mark(job, step, 'failed', error.message);
      throw error;
    }
  }

  async function passwordFor(target, supplied, host) {
    if (supplied) return supplied;
    const stored = await host.call('storage', 'kv.get', {
      key: secretKey(target),
    });
    if (typeof stored === 'string' && stored) return stored;
    const history = await host.call('storage', 'kv.get', { key: HISTORY_KEY });
    const match = Array.isArray(history)
      ? history.find(
          (entry) => sameHistoryTarget(entry, target) && entry.password
        )
      : null;
    return match?.password ? String(match.password) : '';
  }

  async function openSession(target, host) {
    const password = await passwordFor(target, target.password, host);
    const key = sessionCacheKey(target, password);
    const existing = sessions.get(key);
    if (existing) return { session: existing, key };
    const session = (deps.createSession ?? createSshSession)(
      { ...target, password },
      deps.io
    );
    sessions.set(key, session);
    return { session, key };
  }

  async function cancel(job) {
    const key = job?.sessionKey;
    if (!key) return;
    jobSessions.delete(job.id);
    const session = sessions.get(key);
    if (!session) return;
    const stillUsed = [...jobSessions.values()].includes(key);
    if (stillUsed) return;
    sessions.delete(key);
    await session.close?.().catch(() => undefined);
  }

  async function probe(session, onChunk) {
    const output = await session.exec(
      [
        'printf \'os=%s\\narch=%s\\n\' "$(uname -s | tr A-Z a-z)" "$(uname -m)"',
        'printf \'glibc=%s\\n\' "$(getconf GNU_LIBC_VERSION 2>/dev/null | awk \'{print $NF}\')"',
        'command -v vibex || true',
        'command -v vibex-server || true',
        'printf \'home=%s\\n\' "$HOME"',
      ].join('; '),
      30000,
      onChunk
    );
    const os = /os=(\S+)/.exec(output)?.[1] ?? '';
    const arch = /arch=(\S+)/.exec(output)?.[1] ?? '';
    const glibc = /glibc=(\S+)/.exec(output)?.[1] ?? '';
    if (glibcTooOld(glibc)) {
      throw new Error(
        `GLIBC_${glibc} is too old; Linux Host needs glibc 2.34+ (Ubuntu 22.04 or RHEL 9)`
      );
    }
    const hasLauncher = /(^|\n)\/.+\bvibex\b/.test(output) || output.includes('/vibex\n');
    const hasServer = output.includes('vibex-server');
    return { os, arch, glibc, installed: hasLauncher || hasServer, raw: output };
  }

  function remoteUnpackScript(archivePath, tag, platform) {
    const archive = String(archivePath).replace(/'/g, `'\\''`);
    const safeTag = String(tag).replace(/[^A-Za-z0-9._-]/g, '');
    const safePlatform = String(platform).replace(/[^A-Za-z0-9._-]/g, '');
    return [
      'set -eu',
      'export PATH="$HOME/.local/bin:$PATH"',
      `archive='${archive}'`,
      `tag='${safeTag}'`,
      `platform='${safePlatform}'`,
      'family_root="$HOME/.vibex/host-family/$tag/$platform/family"',
      'TEMP=$(mktemp -d)',
      'tar -xzf "$archive" -C "$TEMP"',
      'unpacked="$TEMP/$platform"',
      '[ -f "$unpacked/SHA256SUMS" ] || unpacked="$TEMP"',
      '[ -f "$unpacked/SHA256SUMS" ] || { printf \'archive missing SHA256SUMS\\n\' >&2; exit 1; }',
      'rm -rf "$family_root"',
      'mkdir -p "$(dirname "$family_root")"',
      'mv "$unpacked" "$family_root"',
      'chmod +x "$family_root/vibex-server" "$family_root/vibex-mcp" "$family_root/vibex-workflow-mcp" 2>/dev/null || true',
      'mkdir -p "$HOME/.local/bin"',
      'printf \'#!/bin/sh\\nif [ $# -eq 0 ]; then exec "%s/vibex-server" serve; fi\\nexec "%s/vibex-server" "$@"\\n\' "$family_root" "$family_root" > "$HOME/.local/bin/vibex"',
      'chmod +x "$HOME/.local/bin/vibex"',
      'rm -f "$archive"',
      'printf installed\\n',
    ].join('\n');
  }

  async function fetchArchive(platform, tag, archive, dest, onChunk) {
    if (typeof deps.downloadRelease === 'function') {
      await deps.downloadRelease({ platform, tag, archive, dest, onChunk });
      return;
    }
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const canonical = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${archive}`;
    await downloadFirstOk(canonical, dest, {
      fetchImpl,
      onChunk,
      timeoutMs: 300000,
    });
    await downloadFirstOk(`${canonical}.sha256`, `${dest}.sha256`, {
      fetchImpl,
      onChunk,
      timeoutMs: 60000,
    });
    await verifySidecar(dest, `${dest}.sha256`);
  }

  async function install(session, seen, onChunk) {
    if (seen?.installed) return 'already-installed';
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const platform = platformFromProbe(seen);
    const tag = await resolveLatestTag(GITHUB_REPO, { fetchImpl });
    const archive = `VibeX-${tag.replace(/^v/, '')}-${platform}-server.tar.gz`;
    const tmp = await mkdtemp(join(tmpdir(), 'vibex-host-family-'));
    const localArchive = join(tmp, archive);
    const remoteArchive = `/tmp/${archive}`;
    try {
      onChunk?.({
        stream: 'stdout',
        text: `Downloading ${archive} on this machine\n`,
      });
      await fetchArchive(platform, tag, archive, localArchive, onChunk);
      if (typeof session.push !== 'function') {
        throw new Error('SSH session cannot upload the Host family archive');
      }
      onChunk?.({
        stream: 'stdout',
        text: 'Uploading Host family over SSH\n',
      });
      await session.push(localArchive, remoteArchive, onChunk);
      return session.exec(
        remoteUnpackScript(remoteArchive, tag, platform),
        120000,
        onChunk
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async function start(session, dataDir, onChunk) {
    const dir = String(dataDir ?? '').trim();
    const script = [
      'set -eu',
      'export PATH="$HOME/.local/bin:$PATH"',
      dir ? `export VIBEX_DATA_DIR='${dir.replace(/'/g, `'\\''`)}'` : '',
      'print_addrs() {',
      '  printf \'http://127.0.0.1:17891\\n\'',
      '  if command -v hostname >/dev/null 2>&1; then',
      '    for ip in $(hostname -I 2>/dev/null); do',
      '      printf \'http://%s:17891\\n\' "$ip"',
      '    done',
      '  fi',
      '  pub=$(curl -4 -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)',
      '  if [ -n "$pub" ]; then printf \'http://%s:17891\\n\' "$pub"; fi',
      '}',
      'if curl -fsS --max-time 2 http://127.0.0.1:17891/health >/dev/null 2>&1; then',
      '  printf already-running\\n',
      '  print_addrs',
      '  exit 0',
      'fi',
      'bin=""',
      'if [ -x "$HOME/.local/bin/vibex" ]; then bin="$HOME/.local/bin/vibex"',
      'elif command -v vibex >/dev/null 2>&1; then bin=$(command -v vibex)',
      'elif command -v vibex-server >/dev/null 2>&1; then bin=$(command -v vibex-server)',
      'else',
      '  for candidate in "$HOME/.vibex/host-family/"*/*/family/vibex-server; do',
      '    if [ -x "$candidate" ]; then bin=$candidate; break; fi',
      '  done',
      'fi',
      'if [ -z "$bin" ]; then',
      '  printf \'vibex-server is not installed\\n\' >&2',
      '  exit 1',
      'fi',
      'write_unit() {',
      '  unit_path=$1',
      '  wanted=$2',
      '  mkdir -p "$(dirname -- "$unit_path")"',
      '  cat > "$unit_path" <<UNIT',
      '[Unit]',
      'Description=VibeX Host',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=$bin serve --port 17891',
      'Restart=always',
      'RestartSec=2',
      'Environment=RUST_LOG=error',
      dir ? `Environment=VIBEX_DATA_DIR=${dir.replace(/'/g, '')}` : '',
      'StandardOutput=append:/tmp/vibex-server.log',
      'StandardError=append:/tmp/vibex-server.log',
      '',
      '[Install]',
      'WantedBy=$wanted',
      'UNIT',
      '}',
      'started_with=nohup',
      'if command -v systemctl >/dev/null 2>&1; then',
      '  if [ "$(id -u)" -eq 0 ] && [ -d /etc/systemd/system ]; then',
      '    write_unit /etc/systemd/system/vibex-server.service multi-user.target',
      '    systemctl daemon-reload',
      '    if systemctl is-active --quiet vibex-server.service; then systemctl restart vibex-server.service; else systemctl enable --now vibex-server.service; fi',
      '    started_with=systemd',
      '  elif systemctl --user list-unit-files >/dev/null 2>&1; then',
      '    write_unit "$HOME/.config/systemd/user/vibex-server.service" default.target',
      '    systemctl --user daemon-reload',
      '    if systemctl --user is-active --quiet vibex-server.service; then systemctl --user restart vibex-server.service; else systemctl --user enable --now vibex-server.service; fi',
      '    started_with=systemd-user',
      '  fi',
      'fi',
      'if [ "$started_with" = nohup ]; then',
      '  nohup env RUST_LOG=error "$bin" serve --port 17891 >/tmp/vibex-server.log 2>&1 &',
      'fi',
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
      '  if curl -fsS --max-time 2 http://127.0.0.1:17891/health >/dev/null 2>&1; then',
      '    printf started\\n',
      '    print_addrs',
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
    return session.exec(script, 60000, onChunk);
  }

  async function readHostToken(session, onChunk) {
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
      15000,
      onChunk
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
      const response = await fetchImpl(`${origin.replace(/\/+$/, '')}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function runProvision(job, target, host, options = {}) {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const { session, key: sessionKey } = await openSession(target, host);
    job.sessionKey = sessionKey;
    jobSessions.set(job.id, sessionKey);
    let seen;
    await runStep(job, 'probe', async (onChunk) => {
      appendJobLog(job, 'Checking remote login and architecture', {
        step: 'probe',
      });
      seen = await probe(session, onChunk);
      return `${seen.os}/${seen.arch}`;
    });
    await runStep(job, 'install', async (onChunk) => {
      appendJobLog(job, 'Installing Host family on the remote machine', {
        step: 'install',
      });
      const output = await install(session, seen, onChunk);
      return output.includes('already-installed')
        ? 'already installed'
        : 'installed';
    });
    let advertised = [];
    await runStep(job, 'start', async (onChunk) => {
      appendJobLog(job, 'Starting the remote Host', {
        step: 'start',
      });
      const output = await start(session, target.dataDir, onChunk);
      advertised = String(output)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('http://') || line.startsWith('https://'));
      job.addresses = advertised;
      const label = output.includes('already-running')
        ? 'already running'
        : 'started';
      return advertised[0] ? `${label} ${advertised[0]}` : label;
    });
    let tunnel;
    await runStep(job, 'tunnel', async () => {
      appendJobLog(job, 'Opening a local SSH tunnel', { step: 'tunnel' });
      tunnel = await session.forward(REMOTE_PORT);
      job.origin = tunnel.origin;
      return tunnel.origin;
    });
    const origin = pickDurableOrigin(advertised, target.host);
    if (!origin) {
      throw new Error('remote Host did not advertise a reachable address');
    }
    job.origin = origin;
    let pairingToken = options.pairingToken ?? null;
    if (!options.skipPair) {
      await runStep(job, 'pair', async (onChunk) => {
        appendJobLog(job, 'Requesting a workstation pairing token', {
          step: 'pair',
        });
        const hostToken = await readHostToken(session, onChunk);
        pairingToken = await issuePairing(tunnel.origin, hostToken, fetchImpl);
        return 'workstation';
      });
    } else {
      mark(job, 'pair', 'done', 'kept');
    }
    let profile;
    await runStep(job, 'save', async () => {
      appendJobLog(job, 'Saving the SSH Host', { step: 'save' });
      const name = profileName(target);
      profile = await host.call('remote', 'profile.upsert', {
        id: options.profileId ?? undefined,
        origin,
        name,
        provisionKind: 'ssh',
        provision: {
          host: target.host,
          port: target.port,
          user: target.user,
          jump: target.jump || undefined,
          dataDir: target.dataDir || undefined,
          servicePort: REMOTE_PORT,
          addresses: advertised.length ? advertised : undefined,
        },
      });
      job.profileId = profile.id;
      return name;
    });
    if (!options.skipConnect) {
      await runStep(job, 'connect', async () => {
        appendJobLog(job, 'Opening a window for the remote Host', {
          step: 'connect',
        });
        const result = await host.call('remote', 'connect', {
          profileId: profile.id,
          origin,
          token: pairingToken ?? undefined,
        });
        return result?.profile?.origin ?? origin;
      });
    } else {
      mark(job, 'connect', 'done', 'deferred');
    }
    job.status = 'completed';
    job.origin = origin;
    if (target.password) {
      await host.call('storage', 'kv.put', {
        key: secretKey(target),
        value: target.password,
      });
    }
    return { origin, token: pairingToken, profile };
  }

  async function ensure(input, host) {
    const profile = input.profile ?? {};
    const provision = profile.provision ?? {};
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    let origin = pickDurableOrigin(provision.addresses, provision.host);
    const stored = String(profile.origin ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (!origin && stored && !isLoopbackOrigin(stored)) {
      origin = stored;
    }
    if (origin && (await health(origin, fetchImpl))) {
      if (origin !== stored && profile.id) {
        await saveEnsuredProfile(host, profile, provision, origin);
      }
      return { origin };
    }
    const target = {
      host: provision.host,
      port: provision.port ?? 22,
      user: provision.user,
      jump: provision.jump ?? '',
      dataDir: provision.dataDir ?? '',
      password: input.password ?? '',
    };
    if (!target.host || !target.user) {
      throw new Error('host and user are required');
    }
    const { session } = await openSession(target, host);
    const output = await start(session, target.dataDir);
    const advertised = String(output)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http://') || line.startsWith('https://'));
    origin = pickDurableOrigin(
      advertised.length ? advertised : provision.addresses,
      target.host
    );
    if (!origin || !(await health(origin, fetchImpl))) {
      throw new Error('remote Host did not become healthy');
    }
    await saveEnsuredProfile(host, profile, {
      ...provision,
      addresses: advertised.length ? advertised : provision.addresses,
    }, origin);
    return { origin };
  }

  async function saveEnsuredProfile(host, profile, provision, origin) {
    const name =
      String(profile.name ?? '').trim() ||
      profileName({ user: provision.user, host: provision.host });
    await host.call('remote', 'profile.upsert', {
      id: profile.id || undefined,
      origin,
      name,
      provisionKind: 'ssh',
      provision: {
        host: provision.host,
        port: provision.port,
        user: provision.user,
        jump: provision.jump || undefined,
        dataDir: provision.dataDir || undefined,
        servicePort: REMOTE_PORT,
        addresses: provision.addresses,
      },
    });
  }

  async function forgetTarget(target) {
    const user = String(target?.user ?? '').trim();
    const hostName = String(target?.host ?? '').trim();
    const port = Number(target?.port ?? 22);
    const prefix = `${user}@${hostName}:${port}:`;
    await Promise.all(
      [...sessions.entries()].map(async ([key, session]) => {
        if (!prefix || !key.startsWith(prefix)) return;
        sessions.delete(key);
        await session.close?.().catch(() => undefined);
      })
    );
  }

  async function testLogin(target, host) {
    if (!target?.host || !target?.user) {
      throw new Error('host and user are required');
    }
    await forgetTarget(target);
    const { session, key } = await openSession(target, host);
    try {
      await probe(session);
      return { ok: true };
    } finally {
      sessions.delete(key);
      jobSessions.forEach((value, jobId) => {
        if (value === key) jobSessions.delete(jobId);
      });
      await session.close?.().catch(() => undefined);
    }
  }

  async function dispose() {
    await Promise.all(
      [...sessions.values()].map((session) =>
        session.close?.().catch(() => undefined)
      )
    );
    sessions.clear();
    jobSessions.clear();
  }

  return {
    provision: runProvision,
    ensure,
    cancel,
    testLogin,
    forgetTarget,
    dispose,
    sessions,
  };
}

export function hostFamilyInstaller() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../contents/scripts/install-host-family.sh'),
    join(process.cwd(), 'contents/scripts/install-host-family.sh'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  throw new Error('Host family installer is missing from the plugin package');
}

export function remoteInstallScript() {
  return [
    'set -eu',
    'export PATH="$HOME/.local/bin:$PATH"',
    'if command -v vibex >/dev/null 2>&1 || command -v vibex-server >/dev/null 2>&1 || [ -x "$HOME/.local/bin/vibex" ]; then',
    '  printf already-installed\\n',
    '  exit 0',
    'fi',
    hostFamilyInstaller(),
    'export PATH="$HOME/.local/bin:$PATH"',
    'if [ ! -x "$HOME/.local/bin/vibex" ] && ! command -v vibex >/dev/null 2>&1 && ! command -v vibex-server >/dev/null 2>&1; then',
    '  printf \'install finished but the vibex launcher is missing\\n\' >&2',
    '  exit 1',
    'fi',
  ].join('\n');
}

export { STEPS };
