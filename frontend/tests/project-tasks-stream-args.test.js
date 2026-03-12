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

test('useProjectTasks 使用与其它 Tauri 调用一致的 camelCase 订阅参数', () => {
  const source = readFile('src/hooks/useProjectTasks.ts');

  assert.match(source, /subscribeCommand:\s*'subscribe_tasks_stream'/);
  assert.match(source, /const\s+subscribeArgs\s*=\s*useMemo/);
  assert.match(source, /\(\)\s*=>\s*\(\{\s*projectId\s*\}\)/);
  assert.doesNotMatch(source, /project_id\s*:/);
});
