import { describe, expect, it } from 'vitest';
import {
  buildComposerConflictInstructions,
  getConflictActionState,
  getComposerRepoWithConflicts,
} from './sessionComposerConflicts';

describe('session composer conflict helpers', () => {
  it('selects the first repo with a rebase in progress or conflicted files', () => {
    const cleanRepo = {
      repo_name: 'clean',
      target_branch_name: 'main',
      conflict_op: null,
      is_rebase_in_progress: false,
      conflicted_files: [],
    };
    const rebaseRepo = {
      repo_name: 'rebase-repo',
      target_branch_name: 'main',
      conflict_op: 'rebase' as const,
      is_rebase_in_progress: true,
      conflicted_files: [],
    };
    const conflictedRepo = {
      repo_name: 'conflicted-repo',
      target_branch_name: 'develop',
      conflict_op: 'merge' as const,
      is_rebase_in_progress: false,
      conflicted_files: ['src/app.ts'],
    };

    expect(
      getComposerRepoWithConflicts([cleanRepo, rebaseRepo, conflictedRepo])
    ).toBe(rebaseRepo);
    expect(getComposerRepoWithConflicts([cleanRepo])).toBeUndefined();
    expect(getComposerRepoWithConflicts(undefined)).toBeUndefined();
  });

  it('builds conflict instructions only when files are conflicted', () => {
    expect(
      buildComposerConflictInstructions({
        attemptBranch: 'feature/a',
        repoWithConflicts: {
          repo_name: 'repo-a',
          target_branch_name: 'main',
          conflict_op: 'rebase',
          is_rebase_in_progress: true,
          conflicted_files: [],
        },
      })
    ).toBeNull();

    const instructions = buildComposerConflictInstructions({
      attemptBranch: 'feature/a',
      repoWithConflicts: {
        repo_name: 'repo-a',
        target_branch_name: 'main',
        conflict_op: 'merge',
        is_rebase_in_progress: false,
        conflicted_files: ['src/a.ts', 'src/b.ts'],
      },
    });

    expect(instructions).toContain("Merge conflicts while merging into 'feature/a'");
    expect(instructions).toContain("in repository 'repo-a'");
    expect(instructions).toContain('- src/a.ts');
    expect(instructions).toContain('- src/b.ts');
    expect(instructions).toContain('ensure the merge does not hang');
  });

  it('derives conflict resolve and abort action gates', () => {
    expect(
      getConflictActionState({
        canSendFollowUp: true,
        isAttemptRunning: false,
        isEditable: true,
      })
    ).toEqual({
      enableResolve: true,
      enableAbort: true,
    });

    expect(
      getConflictActionState({
        canSendFollowUp: true,
        isAttemptRunning: false,
        isEditable: false,
      })
    ).toEqual({
      enableResolve: false,
      enableAbort: true,
    });

    expect(
      getConflictActionState({
        canSendFollowUp: true,
        isAttemptRunning: true,
        isEditable: true,
      })
    ).toEqual({
      enableResolve: false,
      enableAbort: false,
    });
  });
});
