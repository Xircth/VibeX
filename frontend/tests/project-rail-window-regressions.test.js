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

test('设置窗口不会再参与项目栏窗口同步', () => {
  const source = readFile('src/components/layout/ProjectWindowManager.tsx');

  assert.match(source, /location\.pathname\.startsWith\('\/settings'\)/);
  assert.match(source, /const shouldManageProjectWindows = !isSettingsWindowRoute/);
  assert.match(source, /if \(!shouldManageProjectWindows \|\| isProjectRailWindow\)/);
  assert.match(source, /tauriListen<boolean>\('project-rail-visibility'/);
});

test('独立项目栏窗口在解析项目列表期间不会直接掉进空状态', () => {
  const source = readFile('src/components/layout/ProjectRail.tsx');

  assert.match(source, /isResolvingStandaloneProjects/);
  assert.match(source, /shouldShowPlaceholderProjects/);
  assert.match(source, /syncProjectRailWindowBounds\(projectRailItemCount\)/);
});

test('项目栏默认隐藏，且可见性不再跨窗口持久化', () => {
  const source = readFile('src/stores/useWindowProjectsStore.ts');

  assert.match(source, /railVisible:\s*false/);
  assert.match(source, /version:\s*3/);
  assert.match(source, /migrate:\s*\(persistedState:\s*unknown\)/);
  assert.doesNotMatch(source, /partialize:[\s\S]*railVisible:/);
});
