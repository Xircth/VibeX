import { describe, expect, it } from 'vitest';
import {
  isCreateSessionFormVisibleForProject,
  resolveDefaultCreateSessionMode,
  shouldRenderExecutionCreateSessionForm,
} from './createSessionFormVisibility';

describe('isCreateSessionFormVisibleForProject', () => {
  it('hides the form when it is closed', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: false,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-a',
      })
    ).toBe(false);
  });

  it('shows the form only for the project that opened it', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-a',
      })
    ).toBe(true);
  });

  it('does not leak an open form into another project', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: 'project-b',
      })
    ).toBe(false);
  });

  it('hides the form when either project id is missing', () => {
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: 'project-a',
        currentProjectId: undefined,
      })
    ).toBe(false);
    expect(
      isCreateSessionFormVisibleForProject({
        open: true,
        openedForProjectId: null,
        currentProjectId: 'project-b',
      })
    ).toBe(false);
  });
});

describe('shouldRenderExecutionCreateSessionForm', () => {
  it('shows the create form on first project entry before a workspace is selected', () => {
    expect(
      shouldRenderExecutionCreateSessionForm({
        bindsExecutionConversation: true,
        isSessionPending: false,
        hasVisibleSession: false,
        hasWorkspaceConversation: false,
      })
    ).toBe(true);
  });

  it('does not replace a bound conversation or a loading session', () => {
    expect(
      shouldRenderExecutionCreateSessionForm({
        bindsExecutionConversation: true,
        isSessionPending: false,
        hasVisibleSession: false,
        hasWorkspaceConversation: true,
      })
    ).toBe(false);
    expect(
      shouldRenderExecutionCreateSessionForm({
        bindsExecutionConversation: true,
        isSessionPending: true,
        hasVisibleSession: false,
        hasWorkspaceConversation: false,
      })
    ).toBe(false);
    expect(
      shouldRenderExecutionCreateSessionForm({
        bindsExecutionConversation: true,
        isSessionPending: false,
        hasVisibleSession: true,
        hasWorkspaceConversation: false,
      })
    ).toBe(false);
  });

  it('stays hidden when the execution conversation is unbound', () => {
    expect(
      shouldRenderExecutionCreateSessionForm({
        bindsExecutionConversation: false,
        isSessionPending: false,
        hasVisibleSession: false,
        hasWorkspaceConversation: false,
      })
    ).toBe(false);
  });
});

describe('resolveDefaultCreateSessionMode', () => {
  it('keeps a git project on existing workspace while options are still loading', () => {
    expect(
      resolveDefaultCreateSessionMode({
        isGitProject: true,
        isWorkspaceOptionsReady: false,
        hasExistingWorkspace: false,
      })
    ).toBe('existing_workspace');
  });

  it('uses existing workspace once a git project has the project-root branch', () => {
    expect(
      resolveDefaultCreateSessionMode({
        isGitProject: true,
        isWorkspaceOptionsReady: true,
        hasExistingWorkspace: true,
      })
    ).toBe('existing_workspace');
  });

  it('falls back to a new workspace only after a git project has no existing option', () => {
    expect(
      resolveDefaultCreateSessionMode({
        isGitProject: true,
        isWorkspaceOptionsReady: true,
        hasExistingWorkspace: false,
      })
    ).toBe('new_workspace');
  });

  it('does not use git workspace modes for a plain directory project', () => {
    expect(
      resolveDefaultCreateSessionMode({
        isGitProject: false,
        isWorkspaceOptionsReady: false,
        hasExistingWorkspace: false,
      })
    ).toBe('existing_workspace');
    expect(
      resolveDefaultCreateSessionMode({
        isGitProject: false,
        isWorkspaceOptionsReady: true,
        hasExistingWorkspace: false,
      })
    ).toBe('existing_workspace');
  });
});
