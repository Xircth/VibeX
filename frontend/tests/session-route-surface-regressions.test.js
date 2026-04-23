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

test('项目主入口与路由表使用 session/workspace 路径而不是旧 task 路径', () => {
  const app = readFile('src/App.tsx');
  const paths = readFile('src/lib/paths.ts');
  const toolbar = readFile('src/components/layout/Toolbar.tsx');
  const navbar = readFile('src/components/layout/Navbar.tsx');
  const welcomePage = readFile('src/components/welcome/WelcomePage.tsx');

  assert.match(app, /path="\/local-projects\/:projectId\/sessions"/);
  assert.match(
    app,
    /path="\/local-projects\/:projectId\/workspaces\/:workspaceId\/full"/
  );
  assert.doesNotMatch(app, /path="\/local-projects\/:projectId\/tasks"/);
  assert.doesNotMatch(app, /tasks\/:taskId\/attempts/);

  assert.match(
    paths,
    /projectSessions:\s*\(projectId: string\)\s*=>\s*`\/local-projects\/\$\{projectId\}\/sessions`/
  );
  assert.doesNotMatch(paths, /projectTasks:/);
  assert.doesNotMatch(paths, /task:\s*\(/);
  assert.doesNotMatch(paths, /attempt:\s*\(/);
  assert.doesNotMatch(paths, /attemptFull:\s*\(/);

  assert.match(toolbar, /paths\.projectSessions\(projectId\)/);
  assert.doesNotMatch(toolbar, /paths\.projectTasks\(projectId\)/);

  assert.match(navbar, /paths\.projectSessions\(projectId\)/);
  assert.doesNotMatch(navbar, /\/tasks/);

  assert.match(welcomePage, /navigate\(`\/local-projects\/\$\{.*\}\/sessions`\)/);
  assert.doesNotMatch(welcomePage, /\/tasks/);
});

test('WorktreeContext 只从 workspace 路径推导当前工作区，不再依赖旧 task/attempt 参数', () => {
  const worktreeContext = readFile('src/contexts/WorktreeContext.tsx');
  const worktreeContextTest = readFile('src/contexts/WorktreeContext.test.tsx');

  assert.match(worktreeContext, /const \{ workspaceId \} = useParams/);
  assert.doesNotMatch(worktreeContext, /attemptId/);
  assert.doesNotMatch(worktreeContext, /useParams<\{[^}]*taskId/);

  assert.match(
    worktreeContextTest,
    /path="\/local-projects\/:projectId\/sessions"/
  );
  assert.match(
    worktreeContextTest,
    /path="\/local-projects\/:projectId\/workspaces\/:workspaceId"/
  );
  assert.doesNotMatch(worktreeContextTest, /\/tasks/);
});
