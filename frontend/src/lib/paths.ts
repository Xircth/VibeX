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

export function splitRouteParts(route: string) {
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

  const taskMatch = pathname.match(
    /^\/local-projects\/([^/]+)\/tasks(?:\/[^/]+)?$/
  );
  if (taskMatch) {
    return `${paths.projectSessions(taskMatch[1])}${search}${hash}`;
  }

  return route;
}

export function parseProjectSessionRoute(route: string): {
  projectId: string;
  workspaceId: string;
  sessionId: string;
} | null {
  const { pathname } = splitRouteParts(route);
  const match = pathname.match(
    /^\/local-projects\/([^/]+)\/workspaces\/([^/]+)\/sessions\/([^/]+)$/
  );
  if (!match) {
    return null;
  }
  return {
    projectId: match[1],
    workspaceId: match[2],
    sessionId: match[3],
  };
}

export function parseProjectWorkspaceRoute(route: string): {
  projectId: string;
  workspaceId: string;
} | null {
  const { pathname } = splitRouteParts(route);
  const match = pathname.match(
    /^\/local-projects\/([^/]+)\/workspaces\/([^/]+)$/
  );
  if (!match) {
    return null;
  }
  return {
    projectId: match[1],
    workspaceId: match[2],
  };
}
