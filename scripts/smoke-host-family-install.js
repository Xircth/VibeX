#!/usr/bin/env node
/**
 * End-to-end smoke for ADR-0073: name an archive the way CI does, serve it,
 * install it through install.sh, and refuse a tampered digest.
 *
 * Does not hit GitHub. The archive is a miniature Host family built in a
 * temp directory so the two-level checksum path is exercised for real.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { archiveName, platformFromNode } = require('../npx-cli/bin/release-assets');

const ROOT = path.join(__dirname, '..');
const VERSION = '0.0.0-smoke';
const PLATFORM = process.env.VIBEX_PLATFORM || platformFromNode(process.platform, process.arch);
if (!PLATFORM) {
  console.error(`unsupported platform: ${process.platform}-${process.arch}`);
  process.exit(2);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeFamily(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const server = path.join(dir, process.platform === 'win32' ? 'vibex-server.exe' : 'vibex-server');
  const script =
    process.platform === 'win32'
      ? '@echo off\necho vibex-server-smoke\n'
      : '#!/bin/sh\necho vibex-server-smoke\n';
  fs.writeFileSync(server, script);
  fs.chmodSync(server, 0o755);
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<html>ok</html>\n');
  const lines = [];
  for (const relative of [
    process.platform === 'win32' ? 'vibex-server.exe' : 'vibex-server',
    'web/index.html',
  ]) {
    lines.push(`${sha256(path.join(dir, ...relative.split('/')))}  ${relative}`);
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function packArchive(familyDir, destDir) {
  const archive = archiveName(VERSION, PLATFORM);
  const nested = path.join(destDir, PLATFORM);
  fs.cpSync(familyDir, nested, { recursive: true });
  const packed = spawnSync('tar', ['-czf', archive, PLATFORM], {
    cwd: destDir,
    stdio: 'inherit',
  });
  if (packed.status !== 0) {
    throw new Error('tar failed');
  }
  const digest = sha256(path.join(destDir, archive));
  fs.writeFileSync(path.join(destDir, `${archive}.sha256`), `${digest}  ${archive}\n`);
  return archive;
}

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, decodeURIComponent(req.url.replace(/^\//, '')));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runInstall(env) {
  const script = path.join(ROOT, 'install.sh');
  return new Promise((resolve) => {
    const child = spawn('sh', [script], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-install-smoke-'));
  const family = path.join(work, 'family');
  const dist = path.join(work, 'dist');
  const home = path.join(work, 'home');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeFamily(family);
  const archive = packArchive(family, dist);
  const { server, origin } = await serve(dist);

  const sharedEnv = {
    HOME: home,
    VIBEX_VERSION: VERSION,
    VIBEX_PLATFORM: PLATFORM,
    VIBEX_HOST_FAMILY_BASE: origin,
    VIBEX_INSTALL_DIR: bin,
    VIBEX_PRINT_PLAN: '',
  };

  try {
    const plan = await runInstall({ ...sharedEnv, VIBEX_PRINT_PLAN: '1' });
    if (plan.status !== 0) {
      throw new Error(
        `plan failed (status=${plan.status} error=${plan.error}):\n${plan.stdout}\n${plan.stderr}`
      );
    }
    if (!plan.stdout.includes(`archive=${archive}`)) {
      throw new Error(`plan named the archive incorrectly:\n${plan.stdout}`);
    }

    const install = await runInstall(sharedEnv);
    if (install.status !== 0) {
      throw new Error(`install failed:\n${install.stdout}\n${install.stderr}`);
    }
    const installed = path.join(home, '.vibex', 'host-family', `v${VERSION}`, PLATFORM, 'family');
    if (!fs.existsSync(path.join(installed, 'SHA256SUMS'))) {
      throw new Error(`install did not land at ${installed}`);
    }

    fs.writeFileSync(path.join(dist, `${archive}.sha256`), `${'0'.repeat(64)}  ${archive}\n`);
    fs.rmSync(path.join(home, '.vibex'), { recursive: true, force: true });
    const tampered = await runInstall(sharedEnv);
    if (tampered.status === 0) {
      throw new Error('install accepted a tampered checksum');
    }
    if (!/checksum mismatch/i.test(`${tampered.stdout}\n${tampered.stderr}`)) {
      throw new Error(`tampered install failed for the wrong reason:\n${tampered.stderr}`);
    }
    if (fs.existsSync(installed)) {
      throw new Error('a failed install left the family in place');
    }

    console.log(`host-family install smoke passed for ${archive}`);
  } finally {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
