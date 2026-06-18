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

test('Logo 组件与设置页展示 VibeX 内部品牌', () => {
  const logoSource = readFrontendFile('src/components/Logo.tsx');
  const settingsSource = readFrontendFile('src/pages/settings/SettingsLayout.tsx');

  assert.match(logoSource, brandPattern);
  assert.match(logoSource, /vibex\.png/);
  assert.match(settingsSource, /Logo/);
});

test('关键前端页面品牌文案更新为 VibeX', () => {
  const welcomeSource = readFrontendFile('src/components/welcome/WelcomePage.tsx');
  const statusBarSource = readFrontendFile('src/components/layout/StatusBar.tsx');
  const onboardingSource = readFrontendFile(
    'src/components/dialogs/global/OnboardingDialog.tsx'
  );
  const disclaimerSource = readFrontendFile(
    'src/components/dialogs/global/DisclaimerDialog.tsx'
  );
  const projectContextSource = readFrontendFile('src/contexts/ProjectContext.tsx');

  assert.doesNotMatch(welcomeSource, /Vibe Kanban Promax/);
  assert.match(welcomeSource, brandPattern);
  assert.doesNotMatch(statusBarSource, /Vibe Kanban Promax/);
  assert.match(statusBarSource, brandPattern);
  assert.doesNotMatch(onboardingSource, /Welcome to Vibe Kanban/);
  assert.match(onboardingSource, brandPattern);
  assert.doesNotMatch(disclaimerSource, /Vibe Kanban runs AI coding agents/);
  assert.match(disclaimerSource, brandPattern);
  assert.doesNotMatch(projectContextSource, /vibe-kanban(?!.*vibex)/);
  assert.match(projectContextSource, brandPattern);
});

test('桌面宿主页不再暴露独立 Web/PWA 图标入口', () => {
  const indexSource = readFrontendFile('index.html');

  assert.doesNotMatch(indexSource, /favicon-vk/);
  assert.doesNotMatch(indexSource, /site\.webmanifest/);
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
