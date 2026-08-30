import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('共享 Tauri 配置承载唯一桌面开发链路', () => {
  const source = readRepoFile('src-tauri/tauri.conf.json');

  assert.match(
    source,
    /"beforeDevCommand"\s*:\s*"pnpm --filter \.\/frontend dev --host 127\.0\.0\.1 --strictPort"/
  );
  assert.match(source, /"devUrl"\s*:\s*"http:\/\/127\.0\.0\.1:3000"/);
  assert.match(source, /"frontendDist"\s*:\s*"\.\.\/frontend\/dist"/);
});

test('根脚本暴露桌面端开发命令', () => {
  const source = readRepoFile('package.json');

  assert.match(source, /"dev"\s*:\s*"pnpm run dev:desktop"/);
  assert.match(source, /"tauri:dev"\s*:\s*"pnpm run tauri:dev:desktop"/);
  assert.match(source, /"tauri:dev:desktop"\s*:\s*"node scripts\/run-tauri-dev-desktop\.js"/);
  assert.match(source, /"dev:desktop"\s*:/);
  assert.doesNotMatch(source, /"frontend:build:watch"\s*:/);
  assert.doesNotMatch(source, /"dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"dev:qa:legacy"\s*:/);
  assert.doesNotMatch(source, /"tauri:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev"\s*:/);
});

test('桌面端启动包装脚本基于共享配置生成临时 dev 配置', () => {
  const source = readRepoFile('scripts/run-tauri-dev-desktop.js');

  assert.match(source, /getPorts/);
  assert.match(source, /tauri\.conf\.json/);
  assert.match(source, /tauri\.dev\.generated\.conf\.json/);
  assert.match(source, /devUrl/);
  assert.match(source, /FRONTEND_PORT/);
  assert.match(source, /BACKEND_PORT/);
  assert.match(source, /applyDesktopDevIdentity/);
  assert.match(source, /com\.vibex\.app\.dev/);
  assert.match(source, /'tauri'/);
  assert.match(source, /'dev'/);
  assert.match(source, /'src-tauri\/tauri\.dev\.generated\.conf\.json'/);
});

test('旧的桌面专用配置和 legacy Web dev 文件已删除', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts', 'dev.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts', 'run-frontend-dev.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src-tauri', 'tauri.legacy.conf.json')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src-tauri', 'tauri.desktop.conf.json')),
    false
  );
});

test('前端包不再保留 build:watch 旧链路脚本', () => {
  const source = readRepoFile('frontend/package.json');

  assert.doesNotMatch(source, /"build:watch"\s*:/);
});

test('README 暴露桌面端开发命令', () => {
  const source = readRepoFile('README.md');

  assert.match(source, /pnpm run dev:desktop/);
  assert.match(source, /pnpm run dev/i);
  assert.match(source, /Vite dev server|HMR|热更新/i);
  assert.doesNotMatch(source, /dev:legacy/);
  assert.doesNotMatch(source, /tauri:dev:legacy/);
  assert.doesNotMatch(source, /frontend:dev:legacy/);
});
