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

test('鎺掗槦涓殑 follow-up 浼氬湪鍘嗗彶鍖哄厛浠ョ敤鎴锋秷鎭疄鏃舵覆鏌?, () => {
  const source = readFrontendFile(
    'src/hooks/useConversationHistory/useConversationHistory.ts'
  );

  assert.match(source, /queryKey:\s*\['queue-status',\s*sessionId\]/);
  assert.match(source, /queueApi\.getStatus\(sessionId!\)/);
  assert.match(source, /queueStatus\?\.status === 'queued'/);
  assert.match(source, /patchKey:\s*`queued:\$\{queueStatus\.message\.session_id\}`/);
  assert.match(source, /type:\s*'user_message'/);
});

test('涓婚鎻愪緵鍣ㄤ細鐩戝惉绯荤粺涓婚鍒囨崲锛岄瑙堢紪杈戝櫒璺熼殢鏄庢殫涓婚', () => {
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

test('Windows 閫氱煡鏄惧紡浣跨敤 VibeX 鐨?AppId 浣滀负 toast sender', () => {
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

test('rebase 鍐茬獊浼氬脊鍑哄彂閫佺粰 AI 鐨勫浐瀹氭ā鏉垮璇濇', () => {
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
