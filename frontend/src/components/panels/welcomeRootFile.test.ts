import { describe, expect, it } from 'vitest';
import {
  pickRandomProjectRootFile,
  resolveWelcomeWorkspaceRootPath,
} from './welcomeRootFile';

describe('pickRandomProjectRootFile', () => {
  it('picks a root-level file and ignores nested paths', () => {
    expect(
      pickRandomProjectRootFile(
        ['README.md', 'src/index.ts', 'package.json'],
        [],
        () => 0
      )
    ).toBe('README.md');
    expect(
      pickRandomProjectRootFile(
        ['README.md', 'src/index.ts', 'package.json'],
        [],
        () => 0.99
      )
    ).toBe('package.json');
  });

  it('skips hidden and gitignored root files', () => {
    expect(
      pickRandomProjectRootFile(
        ['.env', '.gitignore', 'LICENSE', 'secret.txt'],
        ['secret.txt'],
        () => 0
      )
    ).toBe('LICENSE');
  });

  it('returns null when the project root has no eligible files', () => {
    expect(
      pickRandomProjectRootFile(['src/index.ts', '.gitignore'], ['.gitignore'])
    ).toBeNull();
  });
});

describe('resolveWelcomeWorkspaceRootPath', () => {
  it('prefers the already loaded file-tree root', () => {
    expect(
      resolveWelcomeWorkspaceRootPath({
        storedRootPath: '/workspace/tree',
        workspace: {
          container_ref: '/workspace/container',
          use_worktree: false,
          agent_working_dir: null,
        },
        workspaceRepos: [{ name: 'repo', path: '/repos/repo' }],
        projectRepoPath: '/repos/project',
      })
    ).toBe('/workspace/tree');
  });

  it('falls back to the derived workspace root, then the project repo', () => {
    expect(
      resolveWelcomeWorkspaceRootPath({
        storedRootPath: null,
        workspace: {
          container_ref: '/workspace/container',
          use_worktree: false,
          agent_working_dir: null,
        },
        workspaceRepos: [{ name: 'repo', path: '/repos/repo' }],
        projectRepoPath: '/repos/project',
      })
    ).toBe('/repos/repo');

    expect(
      resolveWelcomeWorkspaceRootPath({
        storedRootPath: null,
        workspace: null,
        workspaceRepos: [],
        projectRepoPath: '/repos/project',
      })
    ).toBe('/repos/project');
  });
});
