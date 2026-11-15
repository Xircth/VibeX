import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { importedProjectName } from '@/lib/importedProject';
import { isSettingsSurfacePath } from '@/lib/settingsPreload';
import { cn } from '@/lib/utils';
import {
  useWindowProjectsStore,
  type ProjectActivityAlert,
  type ProjectActivitySnapshot,
  type ProjectRecentSessionSnapshot,
} from '@/stores/useWindowProjectsStore';
import { formatRecentSessionTitle } from './ProjectActivityUi';
import { formatCompactProjectPath } from './projectRailProjects';

const MAX_VISIBLE_PILLS = 4;
const MAX_PREVIEW_SESSIONS = 4;

export type BackgroundProjectVisualState =
  | 'error-unread'
  | 'loading'
  | 'success-unread';

export interface BackgroundActiveProjectItem {
  id: string;
  displayName: string;
  compactPath: string;
  visualState: BackgroundProjectVisualState;
  isRunning: boolean;
  runningCount: number;
  recentSessions: ProjectRecentSessionSnapshot[];
  alert?: ProjectActivityAlert;
}

interface SelectBackgroundProjectsInput {
  projects: Array<{
    id: string;
    name: string;
    root_path?: string | null;
    is_home?: boolean;
  }>;
  currentProjectId?: string | null;
  openProjectIds: string[];
  projectSnapshots: Record<string, ProjectActivitySnapshot | undefined>;
  projectAlerts: Record<string, ProjectActivityAlert | undefined>;
  removedProjectIds: Record<string, true | undefined>;
  resolveProjectName: (project: { name: string; is_home?: boolean }) => string;
}

function getStatePriority(state: BackgroundProjectVisualState): number {
  switch (state) {
    case 'error-unread':
      return 0;
    case 'loading':
      return 1;
    case 'success-unread':
      return 2;
  }
}

export function selectBackgroundActiveProjects(
  input: SelectBackgroundProjectsInput
): BackgroundActiveProjectItem[] {
  const openRank = new Map<string, number>();
  input.openProjectIds.forEach((projectId, index) => {
    if (!openRank.has(projectId)) {
      openRank.set(projectId, index);
    }
  });

  const ranked: Array<{
    item: BackgroundActiveProjectItem;
    priority: number;
    openIndex: number;
    projectIndex: number;
  }> = [];

  input.projects.forEach((candidate, projectIndex) => {
    if (
      candidate.id === input.currentProjectId ||
      input.removedProjectIds[candidate.id]
    ) {
      return;
    }

    const snapshot = input.projectSnapshots[candidate.id];
    const alert = input.projectAlerts[candidate.id];
    const hasUnreadError = Boolean(alert?.unread && alert.kind === 'error');
    const isRunning = Boolean(snapshot?.hasRunning);
    const hasUnreadSuccess = Boolean(alert?.unread && alert.kind === 'success');

    if (!hasUnreadError && !isRunning && !hasUnreadSuccess) {
      return;
    }

    const visualState: BackgroundProjectVisualState = hasUnreadError
      ? 'error-unread'
      : isRunning
        ? 'loading'
        : 'success-unread';

    const runningCount = isRunning
      ? Math.max(1, snapshot?.runningCount ?? 1)
      : 0;

    ranked.push({
      item: {
        id: candidate.id,
        displayName: input.resolveProjectName(candidate),
        compactPath: formatCompactProjectPath(candidate.root_path),
        visualState,
        isRunning,
        runningCount,
        recentSessions: snapshot?.recentSessions ?? [],
        alert: alert?.unread ? alert : undefined,
      },
      priority: getStatePriority(visualState),
      openIndex: openRank.get(candidate.id) ?? Number.MAX_SAFE_INTEGER,
      projectIndex,
    });
  });

  ranked.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.openIndex !== right.openIndex) {
      return left.openIndex - right.openIndex;
    }
    return left.projectIndex - right.projectIndex;
  });

  return ranked.map((entry) => entry.item);
}

function resolvePillStyles(visualState: BackgroundProjectVisualState): string {
  switch (visualState) {
    case 'error-unread':
      return 'border-destructive/40 bg-destructive/10 text-foreground hover:border-destructive/60 hover:bg-destructive/15';
    case 'loading':
      return 'border-primary/35 bg-primary/10 text-foreground hover:border-primary/55 hover:bg-primary/15';
    case 'success-unread':
      return 'border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.1)] text-foreground hover:border-[hsl(var(--success)/0.6)] hover:bg-[hsl(var(--success)/0.15)]';
  }
}

export function BackgroundProjectStatusStrip() {
  const { t } = useTranslation(['statusbar', 'panels', 'app']);
  const location = useLocation();
  const projectContext = useOptionalProject();
  const { projects } = useProjects();
  const switchProject = useProjectSwitcher();

  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const removedProjectIds = useWindowProjectsStore(
    (state) => state.removedProjectIds
  );
  const markProjectAlertRead = useWindowProjectsStore(
    (state) => state.markProjectAlertRead
  );
  const requestProjectFocus = useWindowProjectsStore(
    (state) => state.requestProjectFocus
  );

  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const isSettingsRoute = isSettingsSurfacePath(location.pathname);
  const currentProjectId = projectContext?.projectId ?? null;

  const activeItems = useMemo(() => {
    if (isSettingsRoute) {
      return [];
    }
    return selectBackgroundActiveProjects({
      projects,
      currentProjectId,
      openProjectIds,
      projectSnapshots,
      projectAlerts,
      removedProjectIds,
      resolveProjectName: (candidate) =>
        importedProjectName(candidate, (key) => t(key, { ns: 'app' })),
    });
  }, [
    currentProjectId,
    isSettingsRoute,
    openProjectIds,
    projectAlerts,
    projectSnapshots,
    projects,
    removedProjectIds,
    t,
  ]);

  if (activeItems.length === 0) {
    return null;
  }

  const visibleItems = activeItems.slice(0, MAX_VISIBLE_PILLS);
  const overflowItems = activeItems.slice(MAX_VISIBLE_PILLS);

  const resolveStatusLabel = (item: BackgroundActiveProjectItem): string => {
    if (item.visualState === 'error-unread') {
      return t('panels:projectActivity.statusErrorUnread');
    }
    if (item.visualState === 'loading') {
      return t('statusbar:backgroundProjects.runningStatus', {
        count: item.runningCount,
      });
    }
    return t('panels:projectActivity.statusSuccessUnread');
  };

  const handleSelectProject = (item: BackgroundActiveProjectItem) => {
    setHoveredProjectId(null);
    setOverflowOpen(false);
    if (item.alert?.unread && item.alert.workspaceId && item.alert.sessionId) {
      requestProjectFocus(item.id, {
        workspaceId: item.alert.workspaceId,
        sessionId: item.alert.sessionId,
        requestedAt: Date.now(),
      });
    }
    markProjectAlertRead(item.id);
    switchProject(item.id);
  };

  return (
    <div
      role="region"
      aria-label={t('statusbar:backgroundProjects.ariaLabel')}
      data-testid="background-project-status-strip"
      className="flex min-w-0 items-center gap-1.5 overflow-visible"
    >
      <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border/70" />

      {visibleItems.map((item) => {
        const statusLabel = resolveStatusLabel(item);
        const showPreview = hoveredProjectId === item.id && !overflowOpen;
        const previewSessions = item.recentSessions.slice(
          0,
          MAX_PREVIEW_SESSIONS
        );

        return (
          <div
            key={item.id}
            className="relative flex min-w-0 items-center"
            onMouseEnter={() => setHoveredProjectId(item.id)}
            onMouseLeave={() =>
              setHoveredProjectId((prev) => (prev === item.id ? null : prev))
            }
          >
            <button
              type="button"
              data-testid={`background-project-pill-${item.id}`}
              aria-label={`${t('statusbar:openProject', { name: item.displayName })} · ${statusLabel}`}
              onFocus={() => setHoveredProjectId(item.id)}
              onBlur={() =>
                setHoveredProjectId((prev) => (prev === item.id ? null : prev))
              }
              onClick={() => handleSelectProject(item)}
              className={cn(
                'inline-flex h-6 max-w-40 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                resolvePillStyles(item.visualState)
              )}
            >
              {item.visualState === 'loading' ? (
                <Loader2
                  data-testid={`background-project-spinner-${item.id}`}
                  className="h-3 w-3 shrink-0 animate-spin text-primary"
                  aria-hidden="true"
                />
              ) : (
                <span
                  data-testid={`background-project-dot-${item.id}`}
                  className={cn(
                    'h-2 w-2 shrink-0 animate-pulse rounded-full',
                    item.visualState === 'error-unread'
                      ? 'bg-destructive'
                      : 'bg-[hsl(var(--success))]'
                  )}
                  aria-hidden="true"
                />
              )}

              <span className="min-w-0 truncate">{item.displayName}</span>

              {item.isRunning && item.runningCount > 1 ? (
                <span
                  data-testid={`background-project-running-count-${item.id}`}
                  className="shrink-0 text-[10px] font-semibold text-muted-foreground tabular-nums"
                >
                  {item.runningCount}
                </span>
              ) : null}
            </button>

            {showPreview ? (
              <div
                data-testid={`background-project-preview-${item.id}`}
                className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-xl"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                    {item.displayName}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] font-medium tabular-nums',
                      item.visualState === 'error-unread'
                        ? 'text-destructive'
                        : item.visualState === 'loading'
                          ? 'text-primary'
                          : 'text-[hsl(var(--success))]'
                    )}
                  >
                    {statusLabel}
                  </span>
                </div>

                {item.compactPath ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {item.compactPath}
                  </div>
                ) : null}

                {item.alert?.unread ? (
                  <div
                    className={cn(
                      'mt-2 rounded-md border px-2 py-1.5 text-[11px]',
                      item.alert.kind === 'error'
                        ? 'border-destructive/30 bg-destructive/10 text-foreground'
                        : 'border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] text-foreground'
                    )}
                  >
                    <div className="truncate font-medium">
                      {item.alert.description || item.alert.title}
                    </div>
                  </div>
                ) : null}

                <div className="mt-2">
                  <div className="mb-1.5 truncate text-[11px] font-medium text-muted-foreground">
                    {t('panels:projectActivity.recentSessions')}
                  </div>
                  {previewSessions.length === 0 ? (
                    <div className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs text-muted-foreground">
                      {t('panels:projectActivity.noRecentSessions')}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {previewSessions.map((session) => (
                        <div
                          key={session.sessionId}
                          className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {session.visualState === 'loading' ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                            ) : (
                              <span
                                className={cn(
                                  'h-2 w-2 shrink-0 rounded-full',
                                  session.visualState === 'error'
                                    ? 'bg-destructive'
                                    : session.visualState === 'success'
                                      ? 'bg-[hsl(var(--success))]'
                                      : 'bg-muted-foreground/60'
                                )}
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {formatRecentSessionTitle(session.title)}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                              {session.statusLabel}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {session.subtitle}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {overflowItems.length > 0 ? (
        <Popover
          open={overflowOpen}
          onOpenChange={(nextOpen) => {
            setOverflowOpen(nextOpen);
            if (nextOpen) {
              setHoveredProjectId(null);
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="background-project-overflow-trigger"
              aria-label={t('statusbar:backgroundProjects.moreProjectsAria', {
                count: overflowItems.length,
              })}
              className="inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-border/80 bg-muted/70 px-2 text-[11px] font-semibold text-foreground tabular-nums transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              +{overflowItems.length}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            data-testid="background-project-overflow-popover"
            className="w-72 rounded-xl border border-border bg-popover p-2 text-xs text-popover-foreground shadow-lg"
          >
            <div className="mb-1.5 px-1.5 text-[11px] font-medium text-muted-foreground">
              {t('statusbar:backgroundProjects.moreProjectsTitle')}
            </div>
            <div className="space-y-1">
              {overflowItems.map((item) => {
                const statusLabel = resolveStatusLabel(item);
                const subtitle =
                  item.alert?.description || item.compactPath || statusLabel;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`background-project-overflow-item-${item.id}`}
                    onClick={() => handleSelectProject(item)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.visualState === 'loading' ? (
                      <Loader2
                        className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 animate-pulse rounded-full',
                          item.visualState === 'error-unread'
                            ? 'bg-destructive'
                            : 'bg-[hsl(var(--success))]'
                        )}
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {item.displayName}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {subtitle}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
                      {statusLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
