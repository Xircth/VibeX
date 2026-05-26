import type { ExecutorProfileId } from 'shared/types';

const DEFAULT_SESSION_LABEL = '\u4f1a\u8bdd';

type SessionLabelLike = {
  id: string;
  displayName: string;
  continuityLabel: string;
};

export function getComposerWorkspaceId({
  activeWorktreeId,
  routeWorkspaceId,
  workspaceIdProp,
  sessionWorkspaceId,
}: {
  activeWorktreeId: string | null | undefined;
  routeWorkspaceId: string | null | undefined;
  workspaceIdProp: string | null | undefined;
  sessionWorkspaceId: string | null | undefined;
}): string | null {
  return (
    activeWorktreeId ??
    routeWorkspaceId ??
    workspaceIdProp ??
    sessionWorkspaceId ??
    null
  );
}

export function getComposerSessionId({
  isNewSessionMode,
  sessionId,
}: {
  isNewSessionMode: boolean;
  sessionId: string | null | undefined;
}): string | undefined {
  return isNewSessionMode ? undefined : (sessionId ?? undefined);
}

export function getComposerScratchTargetId({
  isNewSessionMode,
  workspaceId,
  sessionId,
}: {
  isNewSessionMode: boolean;
  workspaceId: string | null | undefined;
  sessionId: string | null | undefined;
}): string | undefined {
  return isNewSessionMode ? (workspaceId ?? undefined) : (sessionId ?? undefined);
}

export function getComposerTopbarVisibility({
  hasTokenUsageInfo,
  hasCodexGoalState,
  showSessionSelector,
  sessionCount,
  hasExecutorProfile,
}: {
  hasTokenUsageInfo: boolean;
  hasCodexGoalState: boolean;
  showSessionSelector: boolean;
  sessionCount: number;
  hasExecutorProfile: boolean;
}): boolean {
  return (
    hasTokenUsageInfo ||
    hasCodexGoalState ||
    (showSessionSelector && sessionCount > 0) ||
    hasExecutorProfile
  );
}

export function getComposerSessionSelectionNotification({
  sessionId,
  workspaceId,
}: {
  sessionId: string;
  workspaceId: string | null | undefined;
}): {
  sessionId: string;
  workspaceId: string;
} | null {
  if (!workspaceId) return null;
  return { sessionId, workspaceId };
}

export function getCreatedSessionProfileMemoryUpdate({
  sessionId,
  profile,
}: {
  sessionId: string;
  profile: Partial<ExecutorProfileId> | null;
}): {
  sessionId: string;
  profile: ExecutorProfileId;
} | null {
  if (!profile?.executor) return null;
  return { sessionId, profile: profile as ExecutorProfileId };
}

export function getSessionRenameInvalidation({
  targetSessionId,
  workspaceId,
}: {
  targetSessionId: string;
  workspaceId: string | null | undefined;
}): {
  workspaceSessionsQueryKey: [string, string] | null;
  sessionQueryKey: [string, string];
} {
  return {
    workspaceSessionsQueryKey: workspaceId
      ? ['workspaceSessions', workspaceId]
      : null,
    sessionQueryKey: ['session', targetSessionId],
  };
}

export function truncateComposerSessionLabel(
  label: string,
  maxUnits = 8
): string {
  if (!label) return DEFAULT_SESSION_LABEL;

  let units = 0;
  let compact = '';

  for (const char of label) {
    const nextUnits = (char.codePointAt(0) ?? 0) > 255 ? 2 : 1;
    if (units + nextUnits > maxUnits) {
      break;
    }
    compact += char;
    units += nextUnits;
  }

  return compact || label;
}

export function getComposerSessionLabels({
  sessions,
  selectedSessionId,
  isNewSessionMode,
}: {
  sessions: readonly SessionLabelLike[];
  selectedSessionId: string | undefined;
  isNewSessionMode: boolean;
}): {
  selectedSessionLabel: string;
  compactSessionLabel: string;
} {
  if (isNewSessionMode) {
    const label = `${DEFAULT_SESSION_LABEL}${sessions.length + 1}`;
    return {
      selectedSessionLabel: label,
      compactSessionLabel: truncateComposerSessionLabel(label),
    };
  }

  const selectedSessionSummary = sessions.find(
    (session) => session.id === selectedSessionId
  );
  const selectedSessionLabel = selectedSessionSummary
    ? `${selectedSessionSummary.displayName} \u8def ${selectedSessionSummary.continuityLabel}`
    : DEFAULT_SESSION_LABEL;
  const compactSource =
    selectedSessionSummary?.displayName ?? DEFAULT_SESSION_LABEL;

  return {
    selectedSessionLabel,
    compactSessionLabel: truncateComposerSessionLabel(compactSource),
  };
}
