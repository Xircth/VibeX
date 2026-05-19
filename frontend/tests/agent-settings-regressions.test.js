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
  const defaultProfiles = readRepoFile(
    'crates/executors/default_profiles.json'
  );

  assert.match(source, /const CODEX_MODEL_OPTIONS = \[/);
  assert.match(source, /'gpt-5\.5'/);
  assert.match(source, /list="codex-model-options"/);
  assert.match(executorSource, /'gpt-5\.5': 'GPT-5\.5'/);
  assert.match(defaultProfiles, /"GPT_5_5"/);
  assert.match(defaultProfiles, /"model": "gpt-5\.5"/);
});

test('agent settings API sends preference mutations through the backend payload argument', () => {
  const source = readFrontendFile('src/lib/api/config.ts');

  assert.match(source, /updatePreferences: async/);
  assert.match(
    source,
    /tauriInvoke<AgentSettingInfo>\('update_agent_preferences'/
  );
  assert.match(source, /payload: \{/);
  assert.match(source, /agent_type: params\.agentType/);
  assert.match(source, /env_json: params\.envJson/);
  assert.match(source, /config_json: params\.configJson/);
  assert.match(source, /tauriInvoke<AgentSettingInfo\[\]>\('reorder_agents'/);
  assert.match(source, /payload: \{ order: agentTypes \}/);
  assert.doesNotMatch(source, /update_agent_preferences', params/);
  assert.doesNotMatch(source, /reorder_agents', \{ agentTypes \}/);
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

test('agent settings hides runtime-only ACP and SDK diagnostics from the card UI', () => {
  const source = readFrontendFile('src/components/settings/AgentCard.tsx');

  assert.match(source, /function isVisibleAgentCheck\(check: PreflightCheck\)/);
  assert.match(source, /check\.check_id === 'runtime_launcher'/);
  assert.match(source, /check\.check_id === 'adapter_version'/);
  assert.match(source, /visibleChecks\.map\(\(check\) =>/);
  assert.match(source, /visibleChecks\.length/);
  assert.doesNotMatch(source, /ProviderRuntimePanel/);
});

test('agent settings version and update actions do not trigger full page refreshes', () => {
  const cardSource = readFrontendFile('src/components/settings/AgentCard.tsx');
  const pageSource = readFrontendFile('src/pages/settings/AgentSettings.tsx');

  assert.match(pageSource, /showLoading: false/);
  assert.match(pageSource, /await loadAgents\(\{\s*showLoading: false\s*\}\);/);
  assert.match(
    cardSource,
    /type="button"[\s\S]*onClick=\{handleDetectVersion\}/
  );
  assert.match(
    cardSource,
    /type="button"[\s\S]*onClick=\{\(\) => void handleRunFix\(upgradeAction\)\}/
  );
  assert.match(cardSource, /await onReload\(\);/);
});
