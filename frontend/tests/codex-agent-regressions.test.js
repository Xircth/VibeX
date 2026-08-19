import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('主题提供器会监听系统主题切换，预览编辑器跟随明暗主题', () => {
  const themeProvider = readFrontendFile('src/components/ThemeProvider.tsx');
  const previewPanel = readFrontendFile(
    'src/components/panels/DockviewPreviewPanel.tsx'
  );

  assert.match(themeProvider, /resolvedTheme/);
  assert.match(themeProvider, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(themeProvider, /addEventListener\('change', handleChange\)/);
  assert.match(themeProvider, /addListener\(handleChange\)/);
  assert.match(previewPanel, /useTheme\(\)/);
  assert.match(previewPanel, /resolvedTheme === 'dark' \? 'vs-dark' : 'vs'/);
});

test('Windows 通知显式使用 VibeX 的 AppId 作为 toast sender', () => {
  const notificationService = readRepoFile(
    'crates/services/src/services/notification.rs'
  );
  const toastScript = readRepoFile('assets/scripts/toast-notification.ps1');

  assert.match(notificationService, /WINDOWS_TOAST_APP_ID/);
  assert.match(notificationService, /com\.vibex\.app/);
  assert.match(notificationService, /\.arg\("-AppId"\)/);
  assert.match(notificationService, /\.arg\("-AppName"\)/);
  assert.match(toastScript, /\[string\]\$AppId = "com\.vibex\.app"/);
  assert.match(toastScript, /CreateToastNotifier\(\$AppId\)/);
});

test('rebase 冲突会弹出发送给 AI 的固定模板对话框', () => {
  const gitOperations = readFrontendFile(
    'src/components/tasks/Toolbar/GitOperations.tsx'
  );
  const branchInfoHeader = readFrontendFile(
    'src/components/layout/BranchInfoHeader.tsx'
  );
  const conflictDialog = readFrontendFile(
    'src/components/dialogs/tasks/GitConflictResolutionDialog.tsx'
  );

  assert.match(gitOperations, /GitConflictResolutionDialog\.show/);
  assert.match(branchInfoHeader, /GitConflictResolutionDialog\.show/);
  assert.match(conflictDialog, /buildResolveConflictsInstructions/);
  assert.match(conflictDialog, /sessionsApi\.followUp/);
  assert.match(conflictDialog, /Send to AI/);
});
