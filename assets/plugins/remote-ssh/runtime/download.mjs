import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const GITHUB_REPO = 'Xircth/VibeX';
export const MIN_GLIBC = { major: 2, minor: 34 };

export function glibcTooOld(version) {
  const match = String(version ?? '').match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < MIN_GLIBC.major ||
    (major === MIN_GLIBC.major && minor < MIN_GLIBC.minor);
}

export const DEFAULT_MIRRORS = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://mirror.ghproxy.com/',
];

export function releaseUrls(canonical) {
  const source = String(canonical ?? '').trim();
  if (!source) return [];
  const extra = String(process.env.VIBEX_DOWNLOAD_MIRRORS ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const prefixes = extra.length ? extra : DEFAULT_MIRRORS;
  const urls = [source];
  for (const prefix of prefixes) {
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
    urls.push(`${base}${source}`);
  }
  return urls;
}

export function platformFromProbe(seen) {
  const os = String(seen?.os ?? '').trim().toLowerCase();
  let arch = String(seen?.arch ?? '').trim().toLowerCase();
  if (arch === 'amd64') arch = 'x86_64';
  if (arch === 'arm64') arch = 'aarch64';
  const platform = `${os}-${arch}`;
  const supported = new Set([
    'linux-x86_64',
    'linux-aarch64',
    'darwin-aarch64',
    'windows-x86_64',
    'windows-aarch64',
  ]);
  if (!supported.has(platform)) {
    throw new Error(`unsupported remote platform: ${platform || '(empty)'}`);
  }
  return platform;
}

export function normalizeTag(tag) {
  const value = String(tag ?? '').trim();
  if (!value) return '';
  return value.startsWith('v') ? value : `v${value}`;
}

export function tagFromReleaseUrl(value) {
  const match = String(value ?? '').match(/\/releases\/tag\/(v?[A-Za-z0-9._-]+)/);
  return match ? normalizeTag(match[1]) : '';
}

function header(response, name) {
  if (!response?.headers) return '';
  if (typeof response.headers.get === 'function') {
    return response.headers.get(name) || response.headers.get(name.toLowerCase()) || '';
  }
  return response.headers[name] || response.headers[name.toLowerCase()] || '';
}

async function readTagFromResponse(response) {
  const fromLocation =
    tagFromReleaseUrl(header(response, 'location')) ||
    tagFromReleaseUrl(response.url);
  if (fromLocation) return fromLocation;
  if (response && response.ok === false && Number(response.status) >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  const type = header(response, 'content-type');
  if (type.includes('json') && typeof response.json === 'function') {
    const payload = await response.json();
    const tag = payload?.tag_name || payload?.tag;
    if (tag) return normalizeTag(tag);
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    const fromBody = tagFromReleaseUrl(text);
    if (fromBody) return fromBody;
    try {
      const payload = JSON.parse(text);
      const tag = payload?.tag_name || payload?.tag;
      if (tag) return normalizeTag(tag);
    } catch {
      // Not JSON.
    }
  } else if (typeof response.json === 'function') {
    const payload = await response.json();
    const tag = payload?.tag_name || payload?.tag;
    if (tag) return normalizeTag(tag);
  }
  throw new Error(`HTTP ${response?.status ?? 'network'}`);
}

export async function resolveLatestTag(repo = GITHUB_REPO, options = {}) {
  const pinned = String(process.env.VIBEX_VERSION ?? '').trim();
  if (pinned) return normalizeTag(pinned);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pages = [
    `https://github.com/${repo}/releases/latest`,
    `https://api.github.com/repos/${repo}/releases/latest`,
  ];
  const errors = [];
  for (const canonical of pages) {
    for (const url of releaseUrls(canonical)) {
      try {
        const response = await fetchImpl(url, {
          redirect: 'follow',
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; vibex-remote-ssh)',
            accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          },
        });
        const tag = await readTagFromResponse(response);
        if (tag) return tag;
        throw new Error('latest release had no tag');
      } catch (error) {
        errors.push(`${url}: ${error.message}`);
      }
    }
  }
  throw new Error(`could not resolve the latest release\n${errors.join('\n')}`);
}

export async function downloadToFile(url, dest, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const onChunk = options.onChunk;
  const timeoutMs = options.timeoutMs ?? 180000;
  const stallMs = options.stallMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    onChunk?.({ stream: 'stdout', text: `GET ${url}\n` });
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'vibex-remote-ssh' },
    });
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? 'network'} from ${url}`);
    }
    const bytes = await readResponseBytes(response, controller, stallMs);
    if (!bytes.length) throw new Error(`empty download from ${url}`);
    await writeFile(dest, bytes);
    onChunk?.({
      stream: 'stdout',
      text: `downloaded ${bytes.length} bytes\n`,
    });
    return bytes.length;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytes(response, controller, stallMs) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return Buffer.from(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let last = Date.now();
  const stall = setInterval(() => {
    if (Date.now() - last > stallMs) controller.abort();
  }, 1000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      last = Date.now();
      chunks.push(Buffer.from(value));
    }
  } finally {
    clearInterval(stall);
  }
  return Buffer.concat(chunks);
}

export async function downloadFirstOk(canonical, dest, options = {}) {
  const errors = [];
  for (const url of releaseUrls(canonical)) {
    try {
      await downloadToFile(url, dest, options);
      return url;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      options.onChunk?.({
        stream: 'stderr',
        text: `download failed: ${error.message}\n`,
      });
    }
  }
  throw new Error(`could not download ${canonical}\n${errors.join('\n')}`);
}

export async function verifySidecar(archivePath, sidecarPath) {
  const sidecar = (await readFile(sidecarPath, 'utf8')).trim();
  const expected = sidecar.split(/\s+/)[0]?.toLowerCase();
  if (!expected) throw new Error('published checksum file was empty');
  const actual = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${archivePath}: expected ${expected}, got ${actual}`
    );
  }
}
