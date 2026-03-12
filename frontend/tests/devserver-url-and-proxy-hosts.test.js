import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const frontendRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('devserver url detection normalizes tauri localhost hostnames back to localhost', () => {
  const source = readFrontendFile('src/hooks/useDevserverUrl.ts');

  assert.match(source, /endsWith\('\.localhost'\)/);
  assert.match(source, /return 'localhost'/);
});

test('preview proxy accepts loopback-style localhost subdomains', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(source, /host\.ends_with\("\.localhost"\)/);
});
