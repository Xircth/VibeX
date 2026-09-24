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
