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

test('设置页头部不再显示 VibeUltra 桌面端设置文案', () => {
  const source = readFile('src/pages/settings/SettingsLayout.tsx');

  assert.doesNotMatch(source, /VibeUltra 桌面端设置/);
});

test('首页品牌标语更新为多任务驱动高效 Vibe Coding', () => {
  const source = readFile('src/lib/branding.ts');

  assert.match(source, /APP_TAGLINE\s*=\s*['"]多任务驱动高效Vibe Coding['"]/);
});

test('Loading History 使用绝对定位遮罩且移除 5 秒强制超时', () => {
  const source = readFile('src/components/logs/VirtualizedList.tsx');

  assert.match(source, /className="relative flex-1 min-h-0"/);
  assert.match(source, /className="absolute inset-0 z-10/);
  assert.doesNotMatch(source, /setTimeout\(\s*\(\)\s*=>\s*\{\s*setLoading\(false\);/);
});

test('历史记录加载在执行进程流初始化完成后主动收敛 loading 状态', () => {
  const source = readFile('src/hooks/useConversationHistory/useConversationHistoryOld.ts');

  assert.match(source, /isLoading:\s*executionProcessesLoading/);
  assert.match(source, /if\s*\(executionProcessesLoading\s*\|\|\s*loadedInitialEntries\.current\)/);
  assert.match(source, /if\s*\(executionProcessesRaw\.length\s*===\s*0\)/);
  assert.match(source, /emitEntries\(displayedExecutionProcesses\.current,\s*'initial',\s*false\)/);
  assert.match(source, /Promise\.all/);
});

test('worktree 选择器受控关闭，并忽略当前 worktree 的重复跳转', () => {
  const source = readFile('src/components/layout/WorktreeSelector.tsx');

  assert.match(source, /const\s*\[open,\s*setOpen\]\s*=\s*useState\(false\)/);
  assert.match(source, /<DropdownMenu\s+open=\{open\}\s+onOpenChange=\{setOpen\}>/);
  assert.match(source, /if\s*\(worktreeInfo\.workspace\.id\s*===\s*activeWorktreeId\)/);
  assert.match(source, /setOpen\(false\);/);
});
