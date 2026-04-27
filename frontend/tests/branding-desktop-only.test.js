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

test('Logo 缁勪欢涓庤缃〉灞曠ず VibeX 鍐呴儴鍝佺墝', () => {
  const logoSource = readFrontendFile('src/components/Logo.tsx');
  const settingsSource = readFrontendFile('src/pages/settings/SettingsLayout.tsx');

  assert.match(logoSource, brandPattern);
  assert.match(logoSource, /vibex\.png/);
  assert.match(settingsSource, /Logo/);
});

test('鍏抽敭鍓嶇椤甸潰鍝佺墝鏂囨鏇存柊涓?VibeX', () => {
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

test('妗岄潰瀹夸富椤典笉鍐嶆毚闇茬嫭绔?Web/PWA 鍥炬爣鍏ュ彛', () => {
  const indexSource = readFrontendFile('index.html');

  assert.doesNotMatch(indexSource, /favicon-vk/);
  assert.doesNotMatch(indexSource, /site\.webmanifest/);
  assert.match(indexSource, /<title>VibeX<\/title>/);
});

test('Tauri 妗岄潰搴旂敤鍚嶇О鏇存柊涓?VibeX', () => {
  const tauriConfigSource = readRepoFile('src-tauri/tauri.conf.json');

  assert.match(tauriConfigSource, /"productName":\s*"VibeX"/);
  assert.match(tauriConfigSource, /"title":\s*"VibeX"/);
});

test('鍒涘缓 PR 瀵硅瘽妗嗕娇鐢ㄦ柊鐨勫搧鐗屽悗缂€', () => {
  const createPrSource = readFrontendFile(
    'src/components/dialogs/tasks/CreatePRDialog.tsx'
  );

  assert.doesNotMatch(createPrSource, /\(vibe-kanban(?!.*ultra)\)/);
  assert.match(createPrSource, /\(VibeX\)|APP_NAME/);
});
