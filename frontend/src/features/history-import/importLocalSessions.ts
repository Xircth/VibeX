import type {
  LocalHistoryScanFolder,
  LocalHistoryScanSession,
} from 'shared/types';

export function localHistorySessionKey(session: {
  agent_id: string;
  external_session_id: string;
}): string {
  return `${session.agent_id}:${session.external_session_id}`;
}

export function isImportableLocalHistorySession(
  session: LocalHistoryScanSession
): boolean {
  return session.status === 'new';
}

export function folderImportableKeys(folder: LocalHistoryScanFolder): string[] {
  return folder.sessions
    .filter(isImportableLocalHistorySession)
    .map(localHistorySessionKey);
}

export function resolveFolderWorkspaceId(
  folder: LocalHistoryScanFolder,
  overrideWorkspaceId: string | undefined
): string | null {
  if (overrideWorkspaceId) {
    return overrideWorkspaceId;
  }
  return folder.workspace_id;
}
