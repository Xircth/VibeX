import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('new project templates can be written to the selected directory', () => {
  const dialogSource = readRepoFile(
    'frontend/src/components/dialogs/projects/ProjectFormDialog.tsx'
  );
  const capability = JSON.parse(
    readRepoFile('src-tauri/capabilities/default.json')
  );

  assert.match(dialogSource, /writeTextFile\(/);

  const writeTextFilePermission = capability.permissions.find(
    (permission) =>
      typeof permission === 'object' &&
      permission.identifier === 'fs:allow-write-text-file'
  );

  assert.deepEqual(writeTextFilePermission?.allow, [{ path: '**' }]);
});
