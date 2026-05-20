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

function readWorkspaceCommandSource() {
  return [
    'src-tauri/src/commands/workspaces.rs',
    'src-tauri/src/commands/workspaces/types.rs',
    'src-tauri/src/commands/workspaces/workspace_sync.rs',
    'src-tauri/src/commands/workspaces/workspace_crud.rs',
    'src-tauri/src/commands/workspaces/git_operations.rs',
    'src-tauri/src/commands/workspaces/workspace_scripts.rs',
    'src-tauri/src/commands/workspaces/workspace_queries.rs',
    'src-tauri/src/commands/workspaces/pull_requests.rs',
    'src-tauri/src/commands/workspaces/pr_import.rs',
    'src-tauri/src/commands/workspaces/commit_commands.rs',
  ]
    .map(readRepoFile)
    .join('\n');
}

test('棰勮鎴愬姛鐘舵€佷笌 Companion 灏辩华鐘舵€佸垎绂?, () => {
  const source = readFrontendFile('src/components/panels/PreviewPanel.tsx');
  const readyContent = readFrontendFile('src/components/tasks/TaskDetails/preview/ReadyContent.tsx');

  assert.match(source, /const\s*\[previewLoaded,\s*setPreviewLoaded\]\s*=\s*useState\(false\)/);
  assert.match(source, /const\s*\[companionReady,\s*setCompanionReady\]\s*=\s*useState\(false\)/);
  assert.match(source, /loadingTimeFinished\s*&&\s*!previewLoaded/);
  assert.match(
    readyContent,
    /onIframeLoad\?:\s*\(iframe:\s*HTMLIFrameElement\s*\|\s*null\)\s*=>\s*void/
  );
  assert.match(readyContent, /onLoad=\{\(\) => onIframeLoad\?\.\(iframeRef\.current\)\}/);
});

test('鍙充晶杈规爮鍚姩寮€鍙戞湇鍔″櫒鍚庝笉鍐嶉噸澶嶅垱寤烘棩蹇楁爣绛?, () => {
  const source = readFrontendFile('src/components/layout/RightPanelSidebar.tsx');

  assert.doesNotMatch(source, /generateTerminalTabId/);
  assert.doesNotMatch(source, /addSession\(/);
  assert.doesNotMatch(source, /PANEL_IDS\.TERMINAL, 'Terminal'/);
});

test('Companion 瀹夎鍏ュ彛鏀逛负鏈湴瀹夎涓庤嚜鍔ㄦ帴鍏?, () => {
  const noServerContent = readFrontendFile('src/components/tasks/TaskDetails/preview/NoServerContent.tsx');
  const helper = readFrontendFile('src/utils/installWebCompanion.ts');
  const api = readFrontendFile('src/lib/api.ts');
  const backend = readWorkspaceCommandSource();
  const tauri = readRepoFile('src-tauri/src/lib.rs');

  assert.doesNotMatch(noServerContent, /createAndStart\.mutate/);
  assert.match(noServerContent, /installWebCompanion/);
  assert.match(helper, /VibeXWebCompanion/);
  assert.match(helper, /src\/main\.(tsx|jsx|ts|js)/);
  assert.match(api, /installWebCompanion:\s*async/);
  assert.match(backend, /pub async fn install_web_companion/);
  assert.match(tauri, /commands::workspaces::install_web_companion/);
});
