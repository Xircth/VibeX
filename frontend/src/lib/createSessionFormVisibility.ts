export function isCreateSessionFormVisibleForProject(input: {
  open: boolean;
  openedForProjectId: string | null | undefined;
  currentProjectId: string | null | undefined;
}): boolean {
  if (!input.open) return false;
  if (!input.openedForProjectId || !input.currentProjectId) return false;
  return input.openedForProjectId === input.currentProjectId;
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
