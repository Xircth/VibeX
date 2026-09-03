import { describe, expect, it } from 'vitest';
import { AgentKind, type ExecutorProfileId } from 'shared/types';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import type { WorkspaceBranchOption } from '@/lib/workspaceBranchOptions';
import {
  UNASSIGNED_EXECUTOR,
  filterKanbanSessions,
  getBulkDeleteSessionSummary,
  getCanCreateKanbanSession,
  getCreateProjectSessionRequest,
  getDisplayedSessionCount,
  getExecutorFilterOptions,
  getSessionMarker,
  groupKanbanSessionsByStatus,
  sessionAttentionKind,
} from './utils';

function session(
  id: string,
  {
    workspaceId,
    executor,
    status,
  }: {
    workspaceId: string;
    executor: string | null;
    status: KanbanProjectSessionRecord['status'];
  }
): KanbanProjectSessionRecord {
  return {
    id,
    executor,
    status,
    workspace: { id: workspaceId },
    fullName: id,
    updatedAt: '2026-05-25T00:00:00.000Z',
  } as KanbanProjectSessionRecord;
}

function workspaceOption(
  overrides: Partial<WorkspaceBranchOption>
): WorkspaceBranchOption {
  return {
    value: 'branch:main',
    branch: 'main',
    workspace: null,
    existingWorkspaceId: null,
    directWorkspaceId: null,
    useWorktree: false,
    isCurrentProjectBranch: false,
    ...overrides,
  };
}

function executorProfile(executor: AgentKind): ExecutorProfileId {
  return { executor } as ExecutorProfileId;
}

describe('session hub data helpers', () => {
  const sessions = [
    session('codex-main', {
      workspaceId: 'workspace-main',
      executor: 'codex' as const,
      status: 'todo',
    }),
    session('unassigned-feature', {
      workspaceId: 'workspace-feature',
      executor: null,
      status: 'inprogress',
    }),
    session('claude-main', {
      workspaceId: 'workspace-main',
      executor: 'claude_code' as const,
      status: 'done',
    }),
  ];

  it('builds sorted executor filter options with an unassigned sentinel', () => {
    expect(getExecutorFilterOptions(sessions)).toEqual([
      {
        value: UNASSIGNED_EXECUTOR,
        label: '未设置代理',
      },
      {
        value: 'claude_code' as const,
        label: 'Claude Code',
      },
      {
        value: 'codex' as const,
        label: 'Codex',
      },
    ]);
  });

  it('filters sessions by workspace and executor selections', () => {
    expect(
      filterKanbanSessions({
        sessions,
        workspaceFilterIds: ['workspace-main'],
        executorFilterValues: ['codex' as const],
      }).map((candidate) => candidate.id)
    ).toEqual(['codex-main']);

    expect(
      filterKanbanSessions({
        sessions,
        workspaceFilterIds: [],
        executorFilterValues: [UNASSIGNED_EXECUTOR],
      }).map((candidate) => candidate.id)
    ).toEqual(['unassigned-feature']);
  });

  it('groups active sessions by status without applying filters', () => {
    expect(groupKanbanSessionsByStatus(sessions)).toEqual({
      todo: [sessions[0]],
      inprogress: [sessions[1]],
      inreview: [],
      done: [sessions[2]],
    });
  });

  it('uses filtered count only when filters or sort are active', () => {
    expect(
      getDisplayedSessionCount({
        workspaceFilterIds: [],
        executorFilterValues: [],
        sortField: null,
        filteredCount: 1,
        activeCount: 3,
      })
    ).toBe(3);

    expect(
      getDisplayedSessionCount({
        workspaceFilterIds: ['workspace-main'],
        executorFilterValues: [],
        sortField: null,
        filteredCount: 2,
        activeCount: 3,
      })
    ).toBe(2);

    expect(
      getDisplayedSessionCount({
        workspaceFilterIds: [],
        executorFilterValues: [],
        sortField: 'time',
        filteredCount: 2,
        activeCount: 3,
      })
    ).toBe(2);
  });

  it('summarizes mixed bulk delete results without inventing missing sessions', () => {
    const deleteResults: PromiseSettledResult<string>[] = [
      { status: 'fulfilled', value: 'codex-main' },
      { status: 'rejected', reason: new Error('delete failed') },
      { status: 'rejected', reason: new Error('missing failed') },
    ];

    const summary = getBulkDeleteSessionSummary({
      targetIds: ['codex-main', 'unassigned-feature', 'missing-session'],
      sessionsById: {
        'codex-main': sessions[0],
        'unassigned-feature': sessions[1],
      },
      sessions,
      deleteResults,
    });

    expect(summary.succeededIds).toEqual(['codex-main']);
    expect(summary.failedSessionIds).toEqual([
      'unassigned-feature',
      'missing-session',
    ]);
    expect(summary.failedResults).toHaveLength(2);
    expect(summary.affectedWorkspaceIds).toEqual([
      'workspace-main',
      'workspace-feature',
    ]);
    expect(Array.from(summary.remainingSessionIds)).toEqual([
      'unassigned-feature',
      'claude-main',
    ]);
  });

  it('summarizes all-success bulk deletes with deduped affected workspaces', () => {
    const deleteResults: PromiseSettledResult<string>[] = [
      { status: 'fulfilled', value: 'codex-main' },
      { status: 'fulfilled', value: 'claude-main' },
    ];

    const summary = getBulkDeleteSessionSummary({
      targetIds: ['codex-main', 'claude-main'],
      sessionsById: {
        'codex-main': sessions[0],
        'claude-main': sessions[2],
      },
      sessions,
      deleteResults,
    });

    expect(summary.succeededIds).toEqual(['codex-main', 'claude-main']);
    expect(summary.failedSessionIds).toEqual([]);
    expect(summary.failedResults).toEqual([]);
    expect(summary.affectedWorkspaceIds).toEqual(['workspace-main']);
    expect(Array.from(summary.remainingSessionIds)).toEqual([
      'unassigned-feature',
    ]);
  });

  it('builds existing-workspace create requests from workspace selections', () => {
    expect(
      getCreateProjectSessionRequest({
        projectId: 'project-1',
        mode: 'existing_workspace',
        workspaceValue: 'workspace:existing',
        workspaceBranchOptions: [
          workspaceOption({
            value: 'workspace:existing',
            existingWorkspaceId: 'workspace-1',
            branch: 'feature/existing',
          }),
        ],
        sessionName: '  Ship fix  ',
        executorProfile: executorProfile('codex' as const),
        repoInputs: [{ repo_id: 'repo-1', target_branch: 'main' }],
      })
    ).toEqual({
      project_id: 'project-1',
      workspace_id: 'workspace-1',
      branch: null,
      executor: 'codex' as const,
      name: 'Ship fix',
      create_workspace: false,
      repos: undefined,
    });
  });

  it('builds branch and new-workspace create requests without leaking blank names', () => {
    expect(
      getCreateProjectSessionRequest({
        projectId: 'project-1',
        mode: 'existing_workspace',
        workspaceValue: 'branch:feature/new',
        workspaceBranchOptions: [
          workspaceOption({
            value: 'branch:feature/new',
            branch: 'feature/new',
          }),
        ],
        sessionName: '   ',
        executorProfile: executorProfile('claude_code' as const),
        repoInputs: undefined,
      })
    ).toEqual({
      project_id: 'project-1',
      workspace_id: null,
      branch: 'feature/new',
      executor: 'claude_code' as const,
      name: null,
      create_workspace: false,
      repos: undefined,
    });

    expect(
      getCreateProjectSessionRequest({
        projectId: 'project-1',
        mode: 'new_workspace',
        workspaceValue: '',
        workspaceBranchOptions: [],
        sessionName: 'New workspace',
        executorProfile: executorProfile('codex' as const),
        repoInputs: [{ repo_id: 'repo-1', target_branch: 'feature/new' }],
      })
    ).toEqual({
      project_id: 'project-1',
      workspace_id: null,
      branch: null,
      executor: 'codex' as const,
      name: 'New workspace',
      create_workspace: true,
      repos: [{ repo_id: 'repo-1', target_branch: 'feature/new' }],
    });
  });

  it('validates create request requirements before building payloads', () => {
    expect(() =>
      getCreateProjectSessionRequest({
        projectId: 'project-1',
        mode: 'existing_workspace',
        workspaceValue: '',
        workspaceBranchOptions: [],
        sessionName: '',
        executorProfile: null,
        repoInputs: undefined,
      })
    ).toThrow('Workspace is required');

    expect(() =>
      getCreateProjectSessionRequest({
        projectId: null,
        mode: 'new_workspace',
        workspaceValue: '',
        workspaceBranchOptions: [],
        sessionName: '',
        executorProfile: null,
        repoInputs: [],
      })
    ).toThrow('Project is required');
  });

  it('derives create-session submit enablement', () => {
    expect(
      getCanCreateKanbanSession({
        executorProfile: executorProfile('codex' as const),
        isPending: false,
        mode: 'existing_workspace',
        selectedWorkspaceOption: workspaceOption({}),
        projectRepoCount: 0,
        repoBranchConfigs: [],
      })
    ).toBe(true);

    expect(
      getCanCreateKanbanSession({
        executorProfile: executorProfile('codex' as const),
        isPending: false,
        mode: 'new_workspace',
        selectedWorkspaceOption: null,
        projectRepoCount: 1,
        repoBranchConfigs: [{ repoId: 'repo-1', targetBranch: 'feature/new' }],
      })
    ).toBe(true);

    expect(
      getCanCreateKanbanSession({
        executorProfile: null,
        isPending: false,
        mode: 'existing_workspace',
        selectedWorkspaceOption: workspaceOption({}),
        projectRepoCount: 0,
        repoBranchConfigs: [],
      })
    ).toBe(false);

    expect(
      getCanCreateKanbanSession({
        executorProfile: executorProfile('codex' as const),
        isPending: true,
        mode: 'existing_workspace',
        selectedWorkspaceOption: workspaceOption({}),
        projectRepoCount: 0,
        repoBranchConfigs: [],
      })
    ).toBe(false);

    expect(
      getCanCreateKanbanSession({
        executorProfile: { executor: 'codex' as const } as never,
        isPending: false,
        mode: 'new_workspace',
        selectedWorkspaceOption: null,
        projectRepoCount: 1,
        repoBranchConfigs: [{ repoId: 'repo-1', targetBranch: '' }],
      })
    ).toBe(false);
  });

  it('maps execution and monitor placements onto session list markers', () => {
    expect(
      getSessionMarker('exec', [{ sessionId: 'monitor-1' }], {
        sessionId: 'exec',
      })
    ).toEqual({ bar: 'session-marker-execution' });
    expect(
      getSessionMarker(
        'monitor-2',
        [{ sessionId: 'monitor-1' }, { sessionId: 'monitor-2' }],
        null
      )
    ).toEqual({
      bar: 'session-marker-slot-2',
      hue: 'var(--session-slot-2)',
    });
    expect(getSessionMarker('idle', [], null)).toBeNull();
    expect(
      getSessionMarker(
        'slot-3',
        [
          { sessionId: 'a' },
          { sessionId: 'b' },
          { sessionId: 'slot-3' },
          { sessionId: 'd' },
        ],
        null
      )
    ).toEqual({
      bar: 'session-marker-slot-3',
      hue: 'var(--session-slot-3)',
    });
    expect(
      getSessionMarker(
        'slot-5',
        [
          { sessionId: 'a' },
          { sessionId: 'b' },
          { sessionId: 'c' },
          { sessionId: 'd' },
          { sessionId: 'slot-5' },
        ],
        null
      )
    ).toEqual({
      bar: 'session-marker-slot-5',
      hue: 'var(--session-slot-5)',
    });
  });
});

describe('sessionAttentionKind', () => {
  it('treats a live turn as running even if status has not caught up', () => {
    expect(
      sessionAttentionKind({ isRunning: true, status: 'inprogress' })
    ).toBe('running');
    expect(sessionAttentionKind({ isRunning: true, status: 'inreview' })).toBe(
      'running'
    );
  });

  it('marks an unviewed finished turn as review', () => {
    expect(sessionAttentionKind({ isRunning: false, status: 'inreview' })).toBe(
      'review'
    );
  });

  it('has no attention chrome once the finished turn has been viewed', () => {
    expect(sessionAttentionKind({ isRunning: false, status: 'done' })).toBe(
      null
    );
    expect(
      sessionAttentionKind({ isRunning: false, status: 'inprogress' })
    ).toBe(null);
  });
});
