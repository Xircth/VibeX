import type {
  LocalHistoryImportLogEntry,
  LocalHistoryImportPhase,
  LocalHistoryImportProgress,
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

const FINISHED_PHASES = new Set<LocalHistoryImportPhase>([
  'imported',
  'skipped',
  'failed',
]);

export function localHistoryImportPercent(
  progress: Pick<LocalHistoryImportProgress, 'current' | 'total' | 'phase'>
): number {
  if (progress.total <= 0) {
    return 0;
  }
  const finished = FINISHED_PHASES.has(progress.phase);
  const completed = finished
    ? progress.current
    : Math.max(0, progress.current - 1);
  const inFlight = finished ? 0 : 0.5;
  return Math.max(
    0,
    Math.min(100, Math.round(((completed + inFlight) / progress.total) * 100))
  );
}

export function localHistoryImportTitle(
  progress: Pick<LocalHistoryImportProgress, 'title' | 'external_session_id'>,
  sessions: Array<
    Pick<LocalHistoryScanSession, 'external_session_id' | 'title'>
  >,
  untitled: string
): string {
  const scanned = sessions.find(
    (session) => session.external_session_id === progress.external_session_id
  );
  return progress.title?.trim() || scanned?.title?.trim() || untitled;
}

export function localHistoryImportLogTitle(
  entry: Pick<LocalHistoryImportLogEntry, 'title' | 'external_session_id'>,
  untitled: string
): string {
  return entry.title?.trim() || untitled;
}

export function formatScanBytes(bytes: number | bigint): string {
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value || 0))} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export type LocalHistoryScanScope = 'existing' | 'global';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseTimeRangeDays(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(days) || days < 1) {
    return null;
  }
  return days;
}

export function isLocalHistorySessionInTimeRange(
  session: Pick<LocalHistoryScanSession, 'updated_at'>,
  days: number | null,
  now: Date = new Date()
): boolean {
  if (days == null) {
    return true;
  }
  if (!session.updated_at) {
    return true;
  }
  const updated = Date.parse(session.updated_at);
  if (!Number.isFinite(updated)) {
    return true;
  }
  return updated >= now.getTime() - days * MS_PER_DAY;
}

export function filterAndSortLocalHistoryFolders({
  folders,
  query,
  onlyImportable,
  timeRangeDays,
  scanScope,
  currentProjectId,
  now = new Date(),
}: {
  folders: LocalHistoryScanFolder[];
  query: string;
  onlyImportable: boolean;
  timeRangeDays: number | null;
  scanScope: LocalHistoryScanScope;
  currentProjectId: string | null;
  now?: Date;
}): LocalHistoryScanFolder[] {
  const needle = query.trim().toLowerCase();
  const filtered = folders.flatMap((folder) => {
    if (scanScope === 'existing' && !folder.project_id) {
      return [];
    }
    let sessions = folder.sessions;
    if (onlyImportable) {
      sessions = sessions.filter(isImportableLocalHistorySession);
    }
    sessions = sessions.filter((session) =>
      isLocalHistorySessionInTimeRange(session, timeRangeDays, now)
    );
    if (needle) {
      const folderMatches =
        folder.path.toLowerCase().includes(needle) ||
        folder.name.toLowerCase().includes(needle);
      if (!folderMatches) {
        sessions = sessions.filter((session) =>
          (session.title ?? '').toLowerCase().includes(needle)
        );
      }
    }
    return sessions.length > 0 ? [{ ...folder, sessions }] : [];
  });

  return sortLocalHistoryFolders(filtered, currentProjectId);
}

export function sortLocalHistoryFolders(
  folders: LocalHistoryScanFolder[],
  currentProjectId: string | null
): LocalHistoryScanFolder[] {
  return [...folders].sort((left, right) => {
    const rankDelta =
      localHistoryFolderRank(left, currentProjectId) -
      localHistoryFolderRank(right, currentProjectId);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (
      currentProjectId &&
      left.project_id === currentProjectId &&
      right.project_id === currentProjectId
    ) {
      const pathLengthDelta = left.path.length - right.path.length;
      if (pathLengthDelta !== 0) {
        return pathLengthDelta;
      }
    }
    return left.path.localeCompare(right.path);
  });
}

function localHistoryFolderRank(
  folder: LocalHistoryScanFolder,
  currentProjectId: string | null
): number {
  if (currentProjectId && folder.project_id === currentProjectId) {
    return 0;
  }
  if (folder.project_id) {
    return 1;
  }
  return 2;
}
