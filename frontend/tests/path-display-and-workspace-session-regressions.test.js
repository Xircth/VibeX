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

test('path display helper strips Windows verbatim prefixes before rendering project and script dialogs', () => {
  const helperSource = readFrontendFile('src/utils/displayPath.ts');
  const projectDialogSource = readFrontendFile(
    'src/components/dialogs/projects/ProjectFormDialog.tsx'
  );
  const scriptDialogSource = readFrontendFile(
    'src/components/dialogs/scripts/ScriptFixerDialog.tsx'
  );
  const truncatePathSource = readFrontendFile('src/utils/TruncatePath.tsx');

  assert.match(helperSource, /export function stripWindowsExtendedPathPrefix/);
  assert.ok(helperSource.includes(".replace(/^\\\\\\\\\\?\\\\UNC\\\\/i, '\\\\\\\\')"));
  assert.match(helperSource, /export function normalizeDisplayPath/);
  assert.match(projectDialogSource, /normalizeDisplayPath\(repo\.path\)/);
  assert.match(projectDialogSource, /const normalizedSelected = normalizeDisplayPath\(selected\);/);
  assert.match(scriptDialogSource, /normalizeDisplayPath\(repo\.path\)/);
  assert.match(truncatePathSource, /const normalizedPath = normalizeDisplayPath\(path\);/);
});

test('workspace session hook preserves explicit new-session mode even when a workspace has no existing sessions yet', () => {
  const source = readFrontendFile('src/hooks/useWorkspaceSessions.ts');

  assert.match(
    source,
    /setSelection\(\(prev\) => \(prev\?\.mode === 'new' \? prev : undefined\)\);/
  );
  assert.doesNotMatch(source, /else \{\s*setSelection\(undefined\);\s*\}/);
});

test('backend repo and filesystem paths strip Windows verbatim prefixes before returning them to the UI', () => {
  const utilsSource = readRepoFile('crates/utils/src/path.rs');
  const repoSource = readRepoFile('crates/db/src/models/repo.rs');
  const repoServiceSource = readRepoFile('crates/services/src/services/repo.rs');
  const filesystemSource = readRepoFile(
    'crates/services/src/services/filesystem.rs'
  );
  const agentNativeSource = readRepoFile(
    'src-tauri/src/commands/config/agent_native.rs'
  );

  assert.match(
    utilsSource,
    /pub fn normalize_windows_extended_path_prefix<P: AsRef<Path>>/
  );
  assert.match(
    utilsSource,
    /normalize_windows_extended_path_prefix_strips_drive_prefix/
  );
  assert.match(
    utilsSource,
    /normalize_windows_extended_path_prefix_strips_unc_prefix/
  );
  assert.match(repoSource, /fn normalize_windows_path\(mut self\) -> Self/);
  assert.match(repoSource, /self\.path = normalize_windows_extended_path_prefix\(&self\.path\);/);
  assert.match(
    repoServiceSource,
    /std::path::absolute\(expand_tilde\(path\)\)\.map\(normalize_windows_extended_path_prefix\)/
  );
  assert.match(
    filesystemSource,
    /current_path: normalize_windows_extended_path_prefix\(path\)/
  );
  assert.match(
    agentNativeSource,
    /normalize_windows_extended_path_prefix\(path\)\s*\.display\(\)\s*\.to_string\(\)/
  );
});
