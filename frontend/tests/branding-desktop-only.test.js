import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');
const brandPattern = /VibeX|APP_NAME/;

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Logo 组件与外观设置展示 VibeX 内部品牌', () => {
  const logoSource = readFrontendFile('src/components/Logo.tsx');
  const settingsSource = readFrontendFile(
    'src/pages/settings/AppearanceSettings.tsx'
  );

  assert.match(logoSource, brandPattern);
  assert.match(logoSource, /resolveAppLogo/);
  assert.match(logoSource, /resolveAppLogo\('lite', resolvedTheme\)/);
  assert.doesNotMatch(logoSource, /getAppIconStyle/);
  assert.match(settingsSource, /appIconStyle/);
  assert.match(settingsSource, /setAppIconStyle/);
});

test('新品牌图标完整覆盖明暗主题与标准、纯标记样式', () => {
  const appIconSource = readFrontendFile('src/lib/appIcon.ts');
  const expectedAssets = [
    'app-logo-light-default.png',
    'app-logo-dark.png',
    'app-logo-light-lite.png',
    'app-logo-dark-lite.png',
  ];

  for (const asset of expectedAssets) {
    assert.match(appIconSource, new RegExp(asset.replace('.', '\\.')));
    assert.ok(fs.existsSync(path.join(frontendRoot, 'src/assets', asset)));
  }
});

test('关键前端页面品牌文案更新为 VibeX', () => {
  const welcomeSource = readFrontendFile(
    'src/components/welcome/WelcomePage.tsx'
  );
  const statusBarSource = readFrontendFile(
    'src/components/layout/StatusBar.tsx'
  );
  const projectContextSource = readFrontendFile(
    'src/contexts/ProjectContext.tsx'
  );

  assert.doesNotMatch(welcomeSource, /Vibe Kanban Promax/);
  assert.match(welcomeSource, brandPattern);
  assert.doesNotMatch(statusBarSource, /Vibe Kanban Promax/);
  assert.match(statusBarSource, brandPattern);
  assert.doesNotMatch(projectContextSource, /vibe-kanban(?!.*vibex)/);
  assert.match(projectContextSource, brandPattern);
});

test('桌面宿主页使用可随主题更新的新应用图标入口', () => {
  const indexSource = readFrontendFile('index.html');

  assert.doesNotMatch(indexSource, /favicon-vk/);
  assert.match(indexSource, /app-logo-light-default\.png/);
  assert.match(indexSource, /data-app-icon/);
  assert.match(indexSource, /<title>VibeX<\/title>/);
});

test('Tauri 桌面应用名称更新为 VibeX', () => {
  const tauriConfigSource = readRepoFile('src-tauri/tauri.conf.json');

  assert.match(tauriConfigSource, /"productName":\s*"VibeX"/);
  assert.match(tauriConfigSource, /"title":\s*"VibeX"/);
});

test('创建 PR 对话框使用新的品牌后缀', () => {
  const createPrSource = readFrontendFile(
    'src/components/dialogs/tasks/CreatePRDialog.tsx'
  );

  assert.doesNotMatch(createPrSource, /\(vibe-kanban(?!.*ultra)\)/);
  assert.match(createPrSource, /\(VibeX\)|APP_NAME/);
});
