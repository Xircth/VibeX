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

test('preview bridge protocol supports console and network events', () => {
  const source = readFrontendFile('src/utils/previewBridge.ts');

  assert.match(source, /export interface PreviewConsolePayload/);
  assert.match(source, /export interface PreviewNetworkPayload/);
  assert.match(source, /type:\s*'console'/);
  assert.match(source, /type:\s*'network'/);
  assert.match(source, /bridgeToken\?: string/);
  assert.match(source, /data\.bridgeToken !== currentBridgeToken/);
  assert.doesNotMatch(source, /postToMessageSource/);
  assert.match(source, /onConsole\?:/);
  assert.match(source, /onNetwork\?:/);
});

test('preview inspector renders console and network tabs with clear actions', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskDetails/preview/PreviewInspectorPane.tsx'
  );

  assert.match(source, /type InspectorTab = 'elements' \| 'console' \| 'network' \| 'logs' \| 'page'/);
  assert.match(source, /label:\s*copy\.console/);
  assert.match(source, /label:\s*copy\.network/);
  assert.match(source, /consoleEntries:/);
  assert.match(source, /networkEntries:/);
  assert.match(source, /onClearConsole:/);
  assert.match(source, /onClearNetwork:/);
});

test('preview proxy capture script installs console and network instrumentation', () => {
  const source = readRepoFile(
    'src-tauri/src/preview_proxy/click_to_component_script.js'
  );

  assert.match(source, /function installConsoleCapture/);
  assert.match(source, /function installNetworkCapture/);
  assert.match(source, /var bridgeToken = null/);
  assert.match(source, /msg\.bridgeToken = bridgeToken/);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /send\('console'/);
  assert.match(source, /send\('network'/);
  assert.match(source, /window\.fetch = function/);
  assert.match(source, /XMLHttpRequest\.prototype\.open/);
  assert.doesNotMatch(source, /\[vk-ctc\] Detected frameworks/);
});

test('frontend no longer uses native confirm dialogs for destructive actions', () => {
  const files = [
    'src/components/projects/ProjectCard.tsx',
    'src/components/projects/ProjectDetail.tsx',
    'src/components/TagManager.tsx',
    'src/components/panels/git/GitBranchList.tsx',
    'src/components/panels/git/GitLogView.tsx',
  ];

  for (const relativePath of files) {
    const source = readFrontendFile(relativePath);
    assert.doesNotMatch(source, /confirm\(|window\.confirm\(/);
    assert.match(source, /ConfirmDialog/);
  }
});
