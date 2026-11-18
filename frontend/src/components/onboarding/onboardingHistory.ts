import type {
  LocalHistoryImportSelection,
  LocalHistoryScanFolder,
} from 'shared/types';
import { localHistorySessionKey } from '@/features/history-import/importLocalSessions';
import { projectsApi } from '@/lib/api/projects';
import { sessionsApi } from '@/lib/api/sessions';

export function onboardingHistoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function groupOnboardingHistory(
  folders: LocalHistoryScanFolder[]
): LocalHistoryScanFolder[] {
  const grouped = new Map<string, LocalHistoryScanFolder>();
  const projectsByPath = new Map(
    folders
      .filter((folder) => folder.project_id && folder.path)
      .map((folder) => [onboardingHistoryPath(folder.path), folder.project_id])
  );
  for (const folder of folders) {
    const projectId =
      folder.project_id ??
      projectsByPath.get(onboardingHistoryPath(folder.path));
    const key = projectId
      ? `project:${projectId}`
      : `path:${onboardingHistoryPath(folder.path)}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...folder, sessions: [...folder.sessions] });
      continue;
    }
    current.project_id ??= folder.project_id;
    current.project_name ??= folder.project_name;
    current.workspace_id ??= folder.workspace_id;
    const sessions = new Map(
      current.sessions.map((session) => [
        localHistorySessionKey(session),
        session,
      ])
    );
    for (const session of folder.sessions)
      sessions.set(localHistorySessionKey(session), session);
    current.sessions = [...sessions.values()];
  }
  for (const folder of grouped.values()) {
    folder.sessions.sort(
      (left, right) =>
        (Date.parse(right.updated_at ?? '') || 0) -
        (Date.parse(left.updated_at ?? '') || 0)
    );
  }
  return [...grouped.values()];
}

export function filterOnboardingHistory(
  folders: LocalHistoryScanFolder[],
  days: number | null,
  now = new Date()
): LocalHistoryScanFolder[] {
  const cutoff = days === null ? null : now.getTime() - days * 86_400_000;
  return folders.flatMap((folder) => {
    const sessions = folder.sessions.filter(
      (session) =>
        session.status === 'new' &&
        (cutoff === null ||
          (session.updated_at !== null &&
            Date.parse(session.updated_at) >= cutoff))
    );
    return sessions.length ? [{ ...folder, sessions }] : [];
  });
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
  // Resolve a root workspace per project. A second full transcript scan here
  // blocked the wizard for minutes and never showed progress.
  const workspaceByProject = new Map<string, string>();
  const resolveWorkspace = async (projectId: string) => {
    const cached = workspaceByProject.get(projectId);
    if (cached) return cached;
    const workspace = await sessionsApi.ensureProjectWorkspace({
      project_id: projectId,
    });
    workspaceByProject.set(projectId, workspace.id);
    return workspace.id;
  };
  const selections = new Map<string, LocalHistoryImportSelection>();
  for (const folder of chosen) {
    const key = onboardingHistoryPath(folder.path);
    const override = destinationOverrides[key] || undefined;
    const projectId = override ?? folder.project_id ?? byPath.get(key);
    if (!projectId) {
      throw new Error(
        `No import destination for ${folder.path || folder.name}`
      );
    }
    const scannedWorkspace =
      !override && folder.project_id === projectId
        ? folder.workspace_id
        : null;
    const workspaceId = scannedWorkspace || (await resolveWorkspace(projectId));
    for (const session of folder.sessions) {
      const sessionKey = localHistorySessionKey(session);
      if (session.status !== 'new' || !selected.has(sessionKey)) continue;
      selections.set(sessionKey, {
        agent_id: session.agent_id,
        external_session_id: session.external_session_id,
        workspace_id: workspaceId,
        title: session.title,
      });
    }
  }
  return { selections: [...selections.values()], projectIds: [...projectIds] };
}
