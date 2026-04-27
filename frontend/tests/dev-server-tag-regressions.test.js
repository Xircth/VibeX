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

test('dev preview no-server state removes AI-hosted startup entry and points users to the built-in tag', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskDetails/preview/NoServerContent.tsx'
  );

  assert.doesNotMatch(source, /AI 托管启动/);
  assert.doesNotMatch(source, /useAiHostedDevServerStart/);
  assert.match(source, /#启动项目开发服务器/);
  assert.match(source, /settingsWindowApi\.open/);
});

test('tag search injects a built-in dev-server startup tag into # suggestions', () => {
  const source = readFrontendFile('src/lib/searchTagsAndFiles.ts');

  assert.match(source, /const BUILTIN_DEV_SERVER_TAG/);
  assert.match(source, /id: 'builtin:start-project-dev-server'/);
  assert.match(source, /tag_name: '启动项目开发服务器'/);
  assert.match(source, /分析当前项目并识别正确的开发服务器启动方式/);
  assert.match(source, /mergedTags\.set/);
});

test('obsolete AI-hosted startup helper files are removed', () => {
  assert.equal(
    fs.existsSync(
      path.join(frontendRoot, 'src/hooks/useAiHostedDevServerStart.ts')
    ),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(frontendRoot, 'src/stores/useAiDevServerStartStore.ts')
    ),
    false
  );
});
