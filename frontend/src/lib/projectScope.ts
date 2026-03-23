export const GLOBAL_PROJECT_SCOPE = '__global__';

export function getProjectScopeKey(projectId?: string | null) {
  return projectId ?? GLOBAL_PROJECT_SCOPE;
}
