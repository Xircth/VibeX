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

test('agent settings page keeps a visible error or empty state instead of silently rendering blank', () => {
  const source = readFrontendFile('src/pages/settings/AgentSettings.tsx');

  assert.match(
    source,
    /const \[loadError, setLoadError\] = useState<string \| null>\(null\);/
  );
  assert.match(source, /setLoadError\(getLoadErrorMessage\(error\)\);/);
  assert.match(source, /无法加载编码代理设置/);
  assert.match(source, /当前没有可用的编码代理/);
  assert.match(source, /onClick=\{\(\) => void loadAgents\(\)\}/);
});

test('agent settings page keeps coding agent cards collapsed by default after loading', () => {
  const source = readFrontendFile('src/pages/settings/AgentSettings.tsx');

  assert.match(source, /setSelectedType\(\(prev\) =>/);
  assert.match(
    source,
    /list\.some\(\(agent\) => agent\.agent_type === prev\)\s*\?\s*prev\s*:\s*null/
  );
  assert.doesNotMatch(source, /list\[0\]\?\.agent_type \?\? null/);
});

test('codex agent settings expose GPT-5.5 as a selectable model suggestion', () => {
  const source = readFrontendFile('src/components/settings/AgentCard.tsx');
  const executorSource = readFrontendFile('src/utils/executor.ts');

  assert.match(source, /const CODEX_MODEL_OPTIONS = \[/);
  assert.match(source, /'gpt-5\.5'/);
  assert.match(source, /list="codex-model-options"/);
  assert.match(executorSource, /'gpt-5\.5': 'GPT-5\.5'/);
});

test('agent settings model backfills default rows before listing or lookup', () => {
  const source = readRepoFile('crates/db/src/models/agent_setting.rs');

  assert.match(source, /const DEFAULT_AGENT_SETTINGS: \[\(&str, i32\); 3\]/);
  assert.match(
    source,
    /pub async fn ensure_defaults\(pool: &SqlitePool\) -> Result<\(\), sqlx::Error>/
  );
  assert.match(source, /INSERT OR IGNORE INTO agent_setting/);
  assert.match(source, /Self::ensure_defaults\(pool\)\.await\?;/);
  assert.match(source, /list_all_backfills_missing_default_agent_rows/);
  assert.match(source, /find_by_type_backfills_defaults_before_lookup/);
});
