export function isCreateSessionFormVisibleForProject(input: {
  open: boolean;
  openedForProjectId: string | null | undefined;
  currentProjectId: string | null | undefined;
}): boolean {
  if (!input.open) return false;
  if (!input.openedForProjectId || !input.currentProjectId) return false;
  return input.openedForProjectId === input.currentProjectId;
}
