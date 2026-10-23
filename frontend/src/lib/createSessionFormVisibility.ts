export function isCreateSessionFormVisibleForProject(input: {
  open: boolean;
  openedForProjectId: string | null | undefined;
  currentProjectId: string | null | undefined;
  openedForWorkspaceId?: string | null | undefined;
  currentWorkspaceId?: string | null | undefined;
}): boolean {
  if (!input.open) return false;
  if (!input.openedForProjectId || !input.currentProjectId) return false;
  if (input.openedForProjectId !== input.currentProjectId) return false;
  if (
    input.openedForWorkspaceId !== undefined ||
    input.currentWorkspaceId !== undefined
  ) {
    return (
      (input.openedForWorkspaceId ?? null) ===
      (input.currentWorkspaceId ?? null)
    );
  }
  return true;
}

/**
 * First landing on the workspace execution area has no routed session. Show
 * the create form there instead of a blank panel. A mounted workspace
 * conversation owns its own empty state and asks the overlay to open.
 */
export function shouldRenderExecutionCreateSessionForm(input: {
  bindsExecutionConversation: boolean;
  isSessionPending: boolean;
  hasVisibleSession: boolean;
  hasWorkspaceConversation: boolean;
}): boolean {
  return (
    input.bindsExecutionConversation &&
    !input.isSessionPending &&
    !input.hasVisibleSession &&
    !input.hasWorkspaceConversation
  );
}

export type DefaultCreateSessionMode = 'existing_workspace' | 'new_workspace';

/**
 * Git projects stay on the project-root current branch ("existing
 * workspace") until options finish loading. Plain directories have no
 * git workspace modes; the form hides that toggle and create still
 * goes through the directory root workspace.
 */
export function resolveDefaultCreateSessionMode(input: {
  isGitProject: boolean;
  isWorkspaceOptionsReady: boolean;
  hasExistingWorkspace: boolean;
}): DefaultCreateSessionMode {
  if (!input.isGitProject) {
    return 'existing_workspace';
  }
  if (!input.isWorkspaceOptionsReady) {
    return 'existing_workspace';
  }
  return input.hasExistingWorkspace ? 'existing_workspace' : 'new_workspace';
}
