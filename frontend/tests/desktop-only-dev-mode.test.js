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

test('存在独立的桌面端 only Tauri 开发配置', () => {
  const source = readRepoFile('src-tauri/tauri.desktop.conf.json');
  const defaultConfig = readRepoFile('src-tauri/tauri.conf.json');

  assert.match(source, /"beforeDevCommand"\s*:\s*"pnpm --filter \.\/frontend build --watch --emptyOutDir false"/);
  assert.match(source, /"devUrl"\s*:\s*null/);
  assert.match(source, /"frontendDist"\s*:\s*"\.\.\/frontend\/dist"/);
  assert.match(defaultConfig, /"devUrl"\s*:\s*null/);
});

test('根脚本暴露桌面端 only 开发命令', () => {
  const source = readRepoFile('package.json');

  assert.match(source, /"dev"\s*:\s*"pnpm run dev:desktop"/);
  assert.match(source, /"tauri:dev"\s*:\s*"pnpm run tauri:dev:desktop"/);
  assert.match(source, /"frontend:build:watch"\s*:/);
  assert.match(source, /"tauri:dev:desktop"\s*:/);
  assert.match(source, /"dev:desktop"\s*:/);
  assert.match(source, /"tauri:dev:desktop"\s*:\s*"node scripts\/run-tauri-dev-desktop\.js"/);
  assert.doesNotMatch(source, /"dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"dev:qa:legacy"\s*:/);
  assert.doesNotMatch(source, /"tauri:dev:legacy"\s*:/);
  assert.doesNotMatch(source, /"frontend:dev"\s*:/);
});

test('存在桌面端 only 启动包装脚本以确保先完成首轮构建', () => {
  const source = readRepoFile('scripts/run-tauri-dev-desktop.js');

  assert.match(source, /frontend:build/);
  assert.match(source, /'tauri'/);
  assert.match(source, /'dev'/);
  assert.match(source, /'src-tauri\/tauri\.desktop\.conf\.json'/);
});

test('legacy Web dev 链路文件已删除', () => {
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
});

test('前端包暴露构建监听脚本', () => {
  const source = readRepoFile('frontend/package.json');

  assert.match(source, /"build:watch"\s*:\s*"vite build --watch --emptyOutDir false"/);
});

test('README 暴露桌面端 only 开发命令', () => {
  const source = readRepoFile('README.md');

  assert.match(source, /pnpm run dev:desktop/);
  assert.match(source, /`?pnpm run dev`? now defaults to desktop-only|`?pnpm run dev`? 作为默认桌面端开发命令/i);
  assert.doesNotMatch(source, /Legacy web dev server workflow/i);
  assert.doesNotMatch(source, /dev:legacy/);
  assert.doesNotMatch(source, /tauri:dev:legacy/);
  assert.doesNotMatch(source, /frontend:dev:legacy/);
});
