import { useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronDown,
  Cpu,
  GitFork,
  Terminal,
} from 'lucide-react';
import type { ExecutorProfileId, MessageTurn, TimelineRow } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceSessionRow } from '@/components/workspace-session-list/WorkspaceSessionList';
import {
  sessionListTitle,
  workspaceSessionStatusTone,
} from '@/components/workspace-session-list/workspaceSessionListModel';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import { useProject } from '@/contexts/ProjectContext';
import { conversationApi } from '@/features/conversation/conversationApi';
import {
  getConversationTimelineView,
  subscribeConversationTimeline,
} from '@/features/conversation/conversationTimelineRegistry';
import { useExecutionProcesses } from '@/hooks/useExecutionProcesses';
import { useKanbanProjectSessions } from '@/hooks/useKanbanProjectSessions';
import { backendCall } from '@/lib/backendTransport';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { SessionFlameGraph } from './SessionFlameGraph';
import {
  activityChartsFromTurns,
  collectWorkspaceActivityNotices,
  collectWorkspaceBackgroundTasks,
  formatDurationMs,
  spanWindow,
  type LiveAgentTerminalItem,
  type SessionTimelineSource,
} from './workspaceActivityModel';

const activityCardClass =
  'flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-none [--workspace-session-row-bg:var(--surface-card)]';

function turnsFromRows(rows: TimelineRow[]): MessageTurn[] {
  return rows.flatMap((row) =>
    row.row.kind === 'message_turn' ? [row.row.turn] : []
  );
}

export function WorkspaceActivityPanel({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { projectId } = useProject();
  const { sessions } = useKanbanProjectSessions(projectId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [sessionsExpanded, setSessionsExpanded] = useState(true);

  const workspaceSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.status !== 'archived' &&
          (!workspaceId || session.workspace.id === workspaceId)
      ),
    [sessions, workspaceId]
  );

  const effectiveProcessSessionId = sessionId ?? workspaceSessions[0]?.id ?? '';
  const { executionProcesses } = useExecutionProcesses(
    effectiveProcessSessionId,
    {
      showSoftDeleted: true,
    }
  );

  const terminalSessions = useTerminalStore((state) =>
    workspaceId ? (state.sessionsByWorkspace[workspaceId] ?? []) : []
  );

  const workspaceSessionIds = useMemo(
    () => new Set(workspaceSessions.map((session) => session.id)),
    [workspaceSessions]
  );

  const { data: liveAgentTerminals = [] } = useQuery({
    queryKey: ['workspace-activity-live-terminals', workspaceId],
    queryFn: async () => {
      try {
        const items = await backendCall<LiveAgentTerminalItem[]>(
          'agent_list_live_terminals'
        );
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    },
  });

  const filteredLiveAgentTerminals = useMemo(
    () =>
      liveAgentTerminals.filter(
        (item) =>
          workspaceSessionIds.has(item.agentSessionId) ||
          (sessionId != null && item.agentSessionId === sessionId)
      ),
    [liveAgentTerminals, sessionId, workspaceSessionIds]
  );

  const detailQueries = useQueries({
    queries: workspaceSessions.map((wsSession) => ({
      queryKey: ['workspace-activity-detail', wsSession.id],
      queryFn: async () => (await conversationApi.detail(wsSession.id)) ?? null,
      enabled: Boolean(wsSession.id),
    })),
  });

  const liveActiveView = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationTimelineView(selectedSessionId ?? sessionId ?? null),
    () => getConversationTimelineView(selectedSessionId ?? sessionId ?? null)
  );

  const sessionTimelines = useMemo<SessionTimelineSource[]>(() => {
    return workspaceSessions.map((wsSession, index) => {
      const detail = detailQueries[index]?.data;
      const detailRows = detail?.timeline?.rows ?? [];
      const detailTurns = turnsFromRows(detailRows);
      const liveView =
        wsSession.id === (selectedSessionId ?? sessionId ?? null)
          ? liveActiveView
          : getConversationTimelineView(wsSession.id);
      const hasLive =
        liveView.timeline.length > 0 || liveView.sideRows.length > 0;

      const liveTurns = liveView.timeline.map((item) => item.turn);
      const failedTurnIds = liveView.timeline
        .filter((item) => item.phase === 'failed')
        .map((item) => item.turn.id);
      const turns =
        hasLive && liveTurns.length >= detailTurns.length
          ? liveTurns
          : detailTurns;
      const rows =
        hasLive && liveView.sideRows.length > 0
          ? liveView.sideRows
          : detailRows;

      return {
        sessionId: wsSession.id,
        sessionName: sessionListTitle(wsSession),
        turns,
        rows,
        failedTurnIds,
      };
    });
  }, [
    detailQueries,
    liveActiveView,
    selectedSessionId,
    sessionId,
    workspaceSessions,
  ]);

  const backgroundTasks = useMemo(
    () =>
      collectWorkspaceBackgroundTasks({
        terminalSessions,
        liveAgentTerminals: filteredLiveAgentTerminals,
        executionProcesses,
        sessionTimelines,
      }),
    [
      executionProcesses,
      filteredLiveAgentTerminals,
      sessionTimelines,
      terminalSessions,
    ]
  );

  const notices = useMemo(
    () =>
      collectWorkspaceActivityNotices({
        sessions: workspaceSessions,
        sessionTimelines,
        executionProcesses,
      }),
    [executionProcesses, sessionTimelines, workspaceSessions]
  );

  const selected = workspaceSessions.find(
    (session) => session.id === selectedSessionId
  );

  const selectedTimeline = useMemo(
    () =>
      sessionTimelines.find((item) => item.sessionId === selectedSessionId) ??
      null,
    [selectedSessionId, sessionTimelines]
  );

  const charts = useMemo(
    () => activityChartsFromTurns(selectedTimeline?.turns ?? []),
    [selectedTimeline]
  );

  const timelineSummary = useMemo(() => {
    let steps = 0;
    let totalDurationMs = 0;
    for (const chart of charts) {
      steps += chart.spans.length;
      if (chart.spans.some((span) => span.timed)) {
        const win = spanWindow(chart.spans);
        totalDurationMs += Math.max(win.endMs - win.startMs, 0);
      }
    }
    return { turns: charts.length, steps, totalDurationMs };
  }, [charts]);

  if (selected) {
    const selectedTitle = sessionListTitle(selected);
    const selectedTone = workspaceSessionStatusTone(selected);
    const selectedAgent = sessionListAgentKey(selected);
    const selectedTurns = selectedTimeline?.turns ?? [];
    const selectedRows = selectedTimeline?.rows ?? [];
    const selectedFailedTurnIds = selectedTimeline?.failedTurnIds ?? [];

    return (
      <TooltipProvider delayDuration={300}>
        <div
          className="flex h-full min-h-0 flex-1 flex-col gap-2.5 overflow-hidden bg-background p-3 text-foreground"
          data-panel="processes"
        >
          <section className="flex shrink-0 items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 shadow-none">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[calc(var(--radius)-6px)] px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
                onClick={() => setSelectedSessionId(null)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('workspaceActivity.backToList')}
              </button>
              <span
                className="h-3.5 w-px shrink-0 bg-[var(--border-subtle)]"
                aria-hidden="true"
              />
              <span
                className="workspace-session-icon shrink-0"
                aria-hidden="true"
              >
                {selectedAgent ? (
                  <AgentIcon
                    agent={selectedAgent as ExecutorProfileId['executor']}
                    className="h-4 w-4"
                  />
                ) : (
                  <Bot className="h-4 w-4 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    'workspace-session-status',
                    `workspace-session-status--${selectedTone}`
                  )}
                />
              </span>
              <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {selectedTitle}
              </h3>
            </div>

            <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
              <span>
                {t('workspaceActivity.turnsCount', {
                  count: timelineSummary.turns,
                })}
              </span>
              <span>·</span>
              <span>
                {t('workspaceActivity.stepsCount', {
                  count: timelineSummary.steps,
                })}
              </span>
              {timelineSummary.totalDurationMs > 0 ? (
                <>
                  <span>·</span>
                  <span className="rounded bg-[var(--surface-control)] px-1.5 py-0.5 text-foreground">
                    {formatDurationMs(timelineSummary.totalDurationMs)}
                  </span>
                </>
              ) : null}
            </div>
          </section>

          {charts.length === 0 && selectedRows.length === 0 ? (
            <section className={activityCardClass}>
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t('workspaceActivity.noSpans')}
              </p>
            </section>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <SessionFlameGraph
                turns={selectedTurns}
                rows={selectedRows}
                failedTurnIds={selectedFailedTurnIds}
                charts={charts}
                onSelectSession={setSelectedSessionId}
              />
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background p-3 text-foreground"
        data-panel="processes"
      >
        <section className={activityCardClass}>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left text-sm font-semibold text-foreground"
            aria-expanded={sessionsExpanded}
            onClick={() => setSessionsExpanded((open) => !open)}
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                sessionsExpanded ? '' : '-rotate-90'
              )}
            />
            <span className="min-w-0 flex-1">
              {t('workspaceActivity.sessions')}
            </span>
            <span className="shrink-0 font-mono text-xs font-normal tabular-nums text-muted-foreground">
              {workspaceSessions.length}
            </span>
          </button>
          {sessionsExpanded && workspaceSessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('workspaceActivity.emptySessions')}
            </p>
          ) : null}
          {sessionsExpanded && workspaceSessions.length > 0 ? (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {workspaceSessions.map((wsSession) => (
                <li key={wsSession.id}>
                  <WorkspaceSessionRow
                    session={wsSession}
                    isSelected={wsSession.id === sessionId}
                    showMarker={false}
                    onClick={() => setSelectedSessionId(wsSession.id)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className={activityCardClass}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('workspaceActivity.background')}
            </h3>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {backgroundTasks.length}
            </span>
          </div>
          {backgroundTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('workspaceActivity.emptyBackground')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {backgroundTasks.map((task) => {
                const TaskIcon =
                  task.kind === 'delegation'
                    ? GitFork
                    : task.kind === 'process'
                      ? Cpu
                      : Terminal;
                return (
                  <li
                    key={task.id}
                    className="flex items-center gap-2.5 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] px-2.5 py-2 text-xs"
                  >
                    <TaskIcon
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">
                        {task.label}
                      </p>
                      {task.subtitle ? (
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {task.subtitle}
                        </p>
                      ) : null}
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-[hsl(var(--success))]">
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--success))]"
                        aria-hidden="true"
                      />
                      {task.detail}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={activityCardClass}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('workspaceActivity.notices')}
            </h3>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {notices.length}
            </span>
          </div>
          {notices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('workspaceActivity.emptyNotices')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {notices.map((notice) => {
                const isError = notice.severity === 'error';
                const NoticeIcon = isError ? AlertCircle : AlertTriangle;
                const canOpenSession = Boolean(
                  notice.sessionId && workspaceSessionIds.has(notice.sessionId)
                );

                return (
                  <li key={notice.id}>
                    <div
                      role={canOpenSession ? 'button' : undefined}
                      tabIndex={canOpenSession ? 0 : undefined}
                      onClick={
                        canOpenSession && notice.sessionId
                          ? () => setSelectedSessionId(notice.sessionId!)
                          : undefined
                      }
                      onKeyDown={
                        canOpenSession && notice.sessionId
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedSessionId(notice.sessionId!);
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        'flex items-start gap-2.5 rounded-[calc(var(--radius)-4px)] border border-[var(--border-subtle)] bg-[var(--surface-control)] px-2.5 py-2 text-xs',
                        canOpenSession &&
                          'cursor-pointer transition-colors hover:bg-[var(--surface-control-hover)]'
                      )}
                    >
                      <NoticeIcon
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 shrink-0',
                          isError
                            ? 'text-destructive'
                            : 'text-[hsl(var(--warning))]'
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">
                            {notice.title}
                          </span>
                          {notice.sessionName &&
                          notice.sessionName !== notice.title ? (
                            <span className="truncate text-xs text-muted-foreground">
                              · {notice.sessionName}
                            </span>
                          ) : null}
                        </div>
                        {notice.message && notice.message !== notice.title ? (
                          <p className="break-words leading-relaxed text-muted-foreground">
                            {notice.message}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}
