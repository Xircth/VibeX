import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('agent settings page is driven by the ACP agent registry', () => {
  const source = readFrontendFile('src/pages/settings/AgentSettings.tsx');

  assert.match(source, /agentsApi\.listRegistry\(\)/);
  assert.match(source, /agentsApi\.listConfigSurfaces\(\)/);
  assert.match(source, /agentsApi\.listMcpSurfaces\(\)/);
  assert.match(source, /agentsApi\.listSkillsSurfaces\(\)/);
  assert.match(source, /agentsApi\.listInstallPlans\(\)/);
  assert.doesNotMatch(source, /agentSettingsApi\.list/);
  assert.doesNotMatch(source, /AgentCard/);
});

test('agent settings page keeps visible loading, error, and empty states', () => {
  const source = readFrontendFile('src/pages/settings/AgentSettings.tsx');

  assert.match(source, /const \[loadError, setLoadError\] = useState<string \| null>\(null\);/);
  assert.match(source, /setLoadError\(getLoadErrorMessage\(error\)\);/);
  assert.match(source, /Agent registry unavailable/);
  assert.match(source, /No agents registered/);
  assert.match(source, /onClick=\{\(\) => void loadAgents\(\)\}/);
});
