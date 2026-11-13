import type {
  LocalHistoryImportSelection,
  LocalHistoryScanFolder,
} from 'shared/types';
import { agentsApi } from '@/features/agents/api';
import { localHistorySessionKey } from '@/features/history-import/importLocalSessions';
import { projectsApi } from '@/lib/api/projects';

export function onboardingHistoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/** Register directories before resolving real import workspaces from the Host. */
export async function prepareOnboardingHistoryImport(
  folders: LocalHistoryScanFolder[],
  selected: ReadonlySet<string>,
  destinationOverrides: Record<string, string>
): Promise<{
  selections: LocalHistoryImportSelection[];
  projectIds: string[];
}> {
  const projects = await projectsApi.getAll();
  const byPath = new Map(
    projects
      .filter((project) => !project.hidden)
      .map((project) => [onboardingHistoryPath(project.root_path), project.id])
  );
  const projectIds = new Set<string>();
  const chosen = folders.filter((folder) =>
    folder.sessions.some(
      (session) =>
        session.status === 'new' &&
        selected.has(localHistorySessionKey(session))
    )
  );
  for (const folder of chosen) {
    const key = onboardingHistoryPath(folder.path);
    let projectId =
      destinationOverrides[key] || folder.project_id || byPath.get(key);
    if (!projectId && folder.path) {
      const project = await projectsApi.create({
        name: folder.name,
        rootPath: folder.path,
        repositories: [],
      });
      projectId = project.id;
      byPath.set(key, project.id);
    }
    if (projectId) projectIds.add(projectId);
  }
  const agentIds = [
    ...new Set(
      chosen.flatMap((folder) =>
        folder.sessions
          .filter((session) => selected.has(localHistorySessionKey(session)))
          .map((session) => session.agent_id)
      )
    ),
  ];
  const scans = await Promise.all(
    agentIds.map((id) => agentsApi.scanLocalHistory(id))
  );
  const allDestinations = scans.flatMap((scan) => scan.destinations);
  const updatedFolders = scans.flatMap((scan) => scan.folders);
  const selections = new Map<string, LocalHistoryImportSelection>();
  for (const folder of chosen) {
    const key = onboardingHistoryPath(folder.path);
    const override = destinationOverrides[key] || undefined;
    const projectId = override ?? folder.project_id ?? byPath.get(key);
    const workspaceId = override
      ? allDestinations.find(
          (destination) => destination.project_id === override
        )?.workspace_id
      : (updatedFolders.find(
          (candidate) =>
            onboardingHistoryPath(candidate.path) === key &&
            candidate.workspace_id
        )?.workspace_id ??
        allDestinations.find(
          (destination) => destination.project_id === projectId
        )?.workspace_id);
    if (!workspaceId)
      throw new Error(
        `No import destination for ${folder.path || folder.name}`
      );
    for (const session of folder.sessions) {
      const sessionKey = localHistorySessionKey(session);
      if (session.status !== 'new' || !selected.has(sessionKey)) continue;
      selections.set(sessionKey, {
        agent_id: session.agent_id,
        external_session_id: session.external_session_id,
        workspace_id: workspaceId,
      });
    }
  }
  return { selections: [...selections.values()], projectIds: [...projectIds] };
}
