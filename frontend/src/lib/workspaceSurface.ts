/**
 * The workspace dock (editor, plugin panels, native browser) is showing.
 * A `/workspaces/:id` or `/sessions/:id` route always forces that surface;
 * otherwise the toolbar tab (`kanban`, `workspace`, or a plugin tab) wins.
 */
export function isWorkspaceSurfaceActive(
  routeWorkspaceId?: string | null,
  routeSessionId?: string | null,
  activeTab?: string | null
): boolean {
  if (routeWorkspaceId || routeSessionId) return true;
  return activeTab === 'workspace';
}

/**
 * Which execution-area conversation binding to use. The workspace tab binds
 * even before a workspace id is in the route (first open of a project).
 */
export function executionConversationSurface(
  routeWorkspaceId?: string | null,
  routeSessionId?: string | null,
  activeTab?: string | null
): 'workspace' | 'kanban' {
  return isWorkspaceSurfaceActive(routeWorkspaceId, routeSessionId, activeTab)
    ? 'workspace'
    : 'kanban';
}
