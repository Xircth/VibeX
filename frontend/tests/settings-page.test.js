import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('设置导航不再包含已弃用的 organizations 入口', () => {
  const source = readFile('src/pages/settings/SettingsLayout.tsx');

  assert.doesNotMatch(source, /path:\s*['"]organizations['"]/);
});

test('通用设置页不再暴露 Remote SSH 相关设置', () => {
  const source = readFile('src/pages/settings/GeneralSettings.tsx');

  assert.doesNotMatch(source, /remote-ssh-host/);
  assert.doesNotMatch(source, /remote-ssh-user/);
});

test('通用设置页暴露发送快捷键设置项', () => {
  const source = readFile('src/pages/settings/GeneralSettings.tsx');

  assert.match(source, /send_message_shortcut/);
});

test('任务跟进输入框读取 send_message_shortcut 配置', () => {
  const source = readFile('src/components/tasks/TaskFollowUpSection.tsx');

  assert.match(
    source,
    /sendShortcut=\{config\?\.send_message_shortcut \?\? 'Enter'\}/
  );
});

test('GeneralSettings 仅在 updateAndSaveConfig 返回成功后展示成功状态', () => {
  const source = readFile('src/pages/settings/GeneralSettings.tsx');

  assert.match(source, /const\s+saved\s*=\s*await\s+updateAndSaveConfig\(/);
  assert.match(source, /if\s*\(!saved\)\s*\{/);
});

test('AgentSettings 仅在 updateAndSaveConfig 返回成功后展示成功状态', () => {
  const source = readFile('src/pages/settings/AgentSettings.tsx');

  assert.match(source, /const\s+saved\s*=\s*await\s+updateAndSaveConfig\(/);
  assert.match(source, /if\s*\(!saved\)\s*\{/);
});

test('AgentSettings 选中项使用蓝底白字样式', () => {
  const source = readFile('src/pages/settings/AgentSettings.tsx');

  assert.match(source, /\? 'bg-accent text-accent-foreground'/);
});

test('SettingsLayout 为设置页滚动容器预留稳定滚动条宽度', () => {
  const source = readFile('src/pages/settings/SettingsLayout.tsx');

  assert.match(source, /\[scrollbar-gutter:stable\]/);
});

test('主题 token 使用按钮前景色作为 primary 前景色', () => {
  const legacyStyles = readFile('src/styles/legacy/index.css');
  const newStyles = readFile('src/styles/new/index.css');

  assert.match(
    legacyStyles,
    /--primary-foreground:\s*var\(\s*--vscode-button-foreground,/
  );
  assert.match(
    newStyles,
    /--primary-foreground:\s*var\(\s*--vscode-button-foreground,/
  );
});
