import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceRootPath,
  deriveWorkspaceRootPathCandidates,
} from './workspaceRootPath';

describe('deriveWorkspaceRootPath', () => {
  it('prefers the single-repo worktree root over the workspace container', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1',
          use_worktree: true,
          agent_working_dir: null,
        },
        [
          {
            name: 'contract-review',
            path: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          },
        ]
      )
    ).toBe(
      'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1\\contract-review'
    );
  });

  it('keeps container_ref unchanged for non-worktree workspaces', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          use_worktree: false,
          agent_working_dir: null,
        },
        [
          {
            name: 'contract-review',
            path: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          },
        ]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\contract-review');
  });

  it('prefers the real repo path for non-worktree workspaces with a stale parent container', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref: 'C:\\Users\\Administrator\\Documents\\Project',
          use_worktree: false,
          agent_working_dir: 'src-tauri',
        },
        [
          {
            name: 'contract-review',
            path: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          },
        ]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\contract-review');
  });

  it('falls back to the repo root segment from agent_working_dir', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1',
          use_worktree: true,
          agent_working_dir: 'contract-review\\app',
        },
        []
      )
    ).toBe(
      'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1\\contract-review'
    );
  });

  it('returns the repo root first and keeps container_ref as a fallback candidate', () => {
    expect(
      deriveWorkspaceRootPathCandidates(
        {
          container_ref:
            'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1',
          use_worktree: true,
          agent_working_dir: null,
        },
        [
          {
            name: 'contract-review',
            path: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          },
        ]
      )
    ).toEqual([
      'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1\\contract-review',
      'C:\\Users\\Administrator\\AppData\\Local\\Temp\\vibe-ultra-dev\\worktrees\\vk\\task-1',
    ]);
  });

  it('does not append the repo name again when container_ref is already the repo root', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          use_worktree: true,
          agent_working_dir: 'contract-review\\app',
        },
        [
          {
            name: 'contract-review',
            path: 'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          },
        ]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\contract-review');
  });
});
