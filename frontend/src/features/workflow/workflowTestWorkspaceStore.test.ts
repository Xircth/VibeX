import { afterEach, describe, expect, it } from 'vitest';

import {
  loadWorkflowTestWorkspace,
  rememberTestWorkspace,
  saveWorkflowTestWorkspace,
  workflowTestWorkspaceKey,
} from './workflowTestWorkspaceStore';

describe('workflowTestWorkspaceStore', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('remembers a test Worktree across load', () => {
    const saved = rememberTestWorkspace('wf-1', 'ws-debug');
    expect(saved).toEqual({
      mode: 'existing',
      workspaceId: 'ws-debug',
      workspaceIds: ['ws-debug'],
    });
    expect(localStorage.getItem(workflowTestWorkspaceKey('wf-1'))).toContain(
      'ws-debug'
    );
    expect(loadWorkflowTestWorkspace('wf-1')).toEqual(saved);
  });

  it('keeps earlier Worktrees when another is recorded', () => {
    saveWorkflowTestWorkspace('wf-1', {
      mode: 'existing',
      workspaceId: 'ws-a',
      workspaceIds: ['ws-a'],
    });
    expect(rememberTestWorkspace('wf-1', 'ws-b').workspaceIds).toEqual([
      'ws-a',
      'ws-b',
    ]);
  });
});
