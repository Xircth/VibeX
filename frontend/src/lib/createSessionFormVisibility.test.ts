import { describe, expect, it } from 'vitest';
import {
  isCreateSessionFormVisibleForProject,
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
