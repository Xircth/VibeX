export const paths = {
  projects: () => '/local-projects',
  projectSessions: (projectId: string) =>
    `/local-projects/${projectId}/sessions`,
  projectWorkspace: (projectId: string, workspaceId: string) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}`,
  projectSession: (projectId: string, workspaceId: string, sessionId: string) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}/sessions/${sessionId}`,
  projectWorkspaceFull: (projectId: string, workspaceId: string) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}/full`,
};

function splitRouteParts(route: string) {
  const hashIndex = route.indexOf('#');
  const hash = hashIndex >= 0 ? route.slice(hashIndex) : '';
  const pathAndSearch = hashIndex >= 0 ? route.slice(0, hashIndex) : route;
  const searchIndex = pathAndSearch.indexOf('?');

  return {
    pathname:
      searchIndex >= 0 ? pathAndSearch.slice(0, searchIndex) : pathAndSearch,
    search: searchIndex >= 0 ? pathAndSearch.slice(searchIndex) : '',
    hash,
  };
}

export function normalizeProjectRoute(route: string) {
  if (!route) {
    return route;
  }

  const { pathname, search, hash } = splitRouteParts(route);

  const fullMatch = pathname.match(
    /^\/local-projects\/([^/]+)\/tasks\/[^/]+\/attempts\/([^/]+)\/full$/
  );
  if (fullMatch) {
    return `${paths.projectWorkspaceFull(fullMatch[1], fullMatch[2])}${search}${hash}`;
  }

  const attemptMatch = pathname.match(
    /^\/local-projects\/([^/]+)\/tasks\/[^/]+\/attempts\/([^/]+)$/
  );
  if (attemptMatch) {
    return `${paths.projectWorkspace(attemptMatch[1], attemptMatch[2])}${search}${hash}`;
  }

  const taskMatch = pathname.match(/^\/local-projects\/([^/]+)\/tasks(?:\/[^/]+)?$/);
  if (taskMatch) {
    return `${paths.projectSessions(taskMatch[1])}${search}${hash}`;
  }

  return route;
}
