import type {
  ExecutionProcess,
  RepoWithTargetBranch,
  Workspace,
} from 'shared/types';
import { attemptsApi, fileTreeApi } from '@/lib/api';
import { getDevServerWorkingDir } from '@/lib/devServerUtils';

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/main.ts',
  'src/main.js',
] as const;

const TOOLBAR_BRIDGE_MARKER = 'data-vibe-ultra-toolbar-bridge';

const TOOLBAR_BRIDGE_SNIPPET = `if (typeof window !== 'undefined') {
  const bridgeRoot = document.documentElement;

  if (!bridgeRoot.hasAttribute('${TOOLBAR_BRIDGE_MARKER}')) {
    bridgeRoot.setAttribute('${TOOLBAR_BRIDGE_MARKER}', 'true');

    const syncToolbarTargeting = (enabled, attempts = 12) => {
      const button = document.querySelector('button[title="Toggle targeting mode"]');

      if (!(button instanceof HTMLButtonElement)) {
        if (attempts > 0) {
          window.setTimeout(() => syncToolbarTargeting(enabled, attempts - 1), 50);
        }
        return;
      }

      const isPressed = button.getAttribute('aria-pressed') === 'true';
      if (isPressed !== enabled) {
        button.click();
      }
    };

    window.addEventListener('message', (event) => {
      const data = event?.data;
      if (
        !data ||
        data.source !== 'click-to-component' ||
        data.version !== 1 ||
        data.type !== 'set-targeting'
      ) {
        return;
      }

      syncToolbarTargeting(Boolean(data.payload?.enabled));
    });

    if (
      window.parent &&
      window.parent !== window &&
      typeof window.parent.postMessage === 'function'
    ) {
      window.parent.postMessage(
        {
          source: 'click-to-component',
          version: 1,
          type: 'toolbar-bridge-ready',
        },
        '*'
      );
    }
  }
}`;

function joinPath(basePath: string, childPath: string): string {
  return `${basePath.replace(/[\\/]+$/, '')}/${childPath}`;
}

function chooseTargetRepo(
  repos: RepoWithTargetBranch[],
  runningDevServers: ExecutionProcess[]
): RepoWithTargetBranch {
  const runningRepoName = runningDevServers[0]
    ? getDevServerWorkingDir(runningDevServers[0])
    : null;

  if (runningRepoName) {
    const matchedRepo = repos.find((repo) => repo.name === runningRepoName);
    if (matchedRepo) {
      return matchedRepo;
    }
  }

  if (repos.length === 1) {
    return repos[0];
  }

  return repos.find((repo) => repo.dev_server_script?.trim()) ?? repos[0];
}

async function findEntryFile(
  repoRoot: string
): Promise<{ path: string; content: string }> {
  for (const relativePath of ENTRY_CANDIDATES) {
    const absolutePath = joinPath(repoRoot, relativePath);
    try {
      const content = await fileTreeApi.readFile(absolutePath);
      return { path: absolutePath, content };
    } catch {
      // try next candidate
    }
  }

  throw new Error('未找到可自动接入的入口文件（支持 src/main.tsx/jsx/ts/js）');
}

function ensureCompanionImport(source: string): string {
  if (source.includes('vibe-ultra-web-companion')) {
    return source;
  }

  return `import { VibeUltraWebCompanion } from 'vibe-ultra-web-companion';\n${source}`;
}

function ensureCompanionRender(source: string): string {
  if (source.includes('<VibeUltraWebCompanion />')) {
    return source;
  }

  if (source.includes('<App />')) {
    return source.replace(
      '<App />',
      `<>
        <App />
        <VibeUltraWebCompanion />
      </>`
    );
  }

  throw new Error('入口文件中未找到 <App />，暂无法自动接入 Web Companion');
}

function ensureCompanionToolbarBridge(source: string): string {
  if (source.includes(TOOLBAR_BRIDGE_MARKER)) {
    return source;
  }

  return `${source.trimEnd()}\n\n${TOOLBAR_BRIDGE_SNIPPET}\n`;
}

export async function installWebCompanion({
  workspaceId,
  attempt,
  repos,
  runningDevServers,
}: {
  workspaceId: string;
  attempt: Workspace | undefined;
  repos: RepoWithTargetBranch[];
  runningDevServers: ExecutionProcess[];
}): Promise<{ entryPath: string; repoName: string }> {
  if (!attempt?.container_ref) {
    throw new Error('当前工作区没有可用的文件目录');
  }

  if (repos.length === 0) {
    throw new Error('当前工作区没有可用仓库');
  }

  const targetRepo = chooseTargetRepo(repos, runningDevServers);
  const repoRoot = joinPath(attempt.container_ref, targetRepo.name);

  await attemptsApi.installWebCompanion(workspaceId, targetRepo.id);

  const { path, content } = await findEntryFile(repoRoot);
  const updated = ensureCompanionToolbarBridge(
    ensureCompanionRender(ensureCompanionImport(content))
  );

  if (updated !== content) {
    await fileTreeApi.saveFile(path, updated);
  }

  return {
    entryPath: path,
    repoName: targetRepo.name,
  };
}
