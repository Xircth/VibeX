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

test('NextActionCard 拆分为更清晰的职责块', () => {
  const source = readFile(
    'src/components/NormalizedConversation/NextActionCard.tsx'
  );

  assert.match(source, /function NextActionHeader/);
  assert.match(source, /function DiffSummarySection/);
  assert.match(source, /function ActionButtonsSection/);
});

test('NextActionCard 的查看差异使用统一的 diff 面板入口', () => {
  const source = readFile(
    'src/components/NormalizedConversation/NextActionCard.tsx'
  );

  assert.match(source, /openDiffPreview/);
  assert.doesNotMatch(source, /\?view=diffs/);
  assert.doesNotMatch(source, /useNavigate\(/);
});

test('NextActionCard 不再包含开发服务器操作按钮', () => {
  const source = readFile(
    'src/components/NormalizedConversation/NextActionCard.tsx'
  );

  assert.doesNotMatch(source, /useDevServer/);
  assert.doesNotMatch(source, /useHasDevServerScript/);
  assert.doesNotMatch(source, /ViewProcessesDialog/);
  assert.doesNotMatch(source, /启动开发/);
  assert.doesNotMatch(source, /查看开发服务器日志/);
});

test('NextActionCard 标题区域不再使用红色失败态样式', () => {
  const source = readFile(
    'src/components/NormalizedConversation/NextActionCard.tsx'
  );

  assert.doesNotMatch(source, /bg-destructive\/10 text-destructive/);
  assert.match(source, /bg-muted/);
});
