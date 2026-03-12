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

test('新建会话模式下 TaskAttemptPanel 不回退到旧会话', () => {
  const source = readFrontendFile('src/components/panels/TaskAttemptPanel.tsx');

  assert.match(source, /sessionState\.isNewSessionMode/);
  assert.doesNotMatch(source, /selectedSession \?\? attempt\.session/);
  assert.match(source, /activeSession\?\.id \?\? 'new'/);
});

test('workspace sessions 使用 session summaries 并展示标题与状态', () => {
  const hookSource = readFrontendFile('src/hooks/useWorkspaceSessions.ts');
  const uiSource = readFrontendFile('src/components/tasks/TaskFollowUpSection.tsx');
  const apiSource = readFrontendFile('src/lib/api.ts');

  assert.match(hookSource, /getSummariesByWorkspace/);
  assert.match(hookSource, /displayName|title|firstPrompt/);
  assert.match(uiSource, /running|queued|idle|运行中|排队中|空闲/);
  assert.match(apiSource, /getSummariesByWorkspace:\s*async/);
});

test('后端存在 session summary 命令与 session 级运行检查', () => {
  const sessionsCommand = readRepoFile('src-tauri/src/commands/sessions.rs');
  const libSource = readRepoFile('src-tauri/src/lib.rs');
  const processModel = readRepoFile('crates/db/src/models/execution_process.rs');

  assert.match(sessionsCommand, /pub async fn get_session_summaries/);
  assert.match(libSource, /commands::sessions::get_session_summaries/);
  assert.match(processModel, /has_running_non_dev_server_processes_for_session/);
  assert.doesNotMatch(sessionsCommand, /has_running_non_dev_server_processes_for_workspace\(pool, workspace.id\)/);
});

test('通用对话框增加最大高度与滚动能力', () => {
  const source = readFrontendFile('src/components/ui/dialog.tsx');

  assert.match(source, /max-h-\[calc\(100dvh-2rem\)\]/);
  assert.match(source, /overflow-y-auto/);
});
