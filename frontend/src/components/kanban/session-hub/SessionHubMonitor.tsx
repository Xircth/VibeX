import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { cn } from '@/lib/utils';
import {
  MONITOR_SLOT_STYLES,
  formatTimeAgo,
  getMonitorGridClassName,
  getMonitorItemClassName,
} from './utils';

interface SessionHubMonitorProps {
  monitorRecords: KanbanProjectSessionRecord[];
  canUseRightPanelForSessions: boolean;
  onOpenInExecutionArea: (session: KanbanProjectSessionRecord) => void;
  onCancelMonitor: (session: KanbanProjectSessionRecord) => void;
}

export function SessionHubMonitor({
  monitorRecords,
  canUseRightPanelForSessions,
  onOpenInExecutionArea,
  onCancelMonitor,
}: SessionHubMonitorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const monitorGridClassName = getMonitorGridClassName(monitorRecords.length);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="session-hub-monitor-inner flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-[var(--surface-content)]',
            monitorRecords.length === 0 && 'border border-dashed border-border'
          )}
        >
          {monitorRecords.length === 0 ? (
            <div className="flex h-8 shrink-0 items-center px-3 text-sm font-semibold text-foreground">
              {t('hubMonitor.title')}
            </div>
          ) : null}

          {monitorRecords.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('hubMonitor.emptyHint')}
            </div>
          ) : (
            <div
              className={cn(
                'grid min-h-0 flex-1 gap-4 p-1',
                monitorGridClassName
              )}
            >
              {monitorRecords.map((session, index) => (
                <div
                  key={session.id}
                  className={cn(
                    'flex min-h-0 flex-col overflow-hidden rounded-lg border transition-colors hover:bg-[var(--surface-control-hover)]',
                    // 会话报错时整卡切换为红色错误态边框，覆盖默认 Slot 配色，便于一眼定位出错的监控位。
                    session.isErrored
                      ? 'session-monitor-slot-error'
                      : MONITOR_SLOT_STYLES[index]?.shell,
                    getMonitorItemClassName(monitorRecords.length, index)
                  )}
                >
                  <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Badge
                        variant="secondary"
                        className="h-5 min-w-0 max-w-full shrink rounded-lg border-transparent bg-[var(--surface-control)] px-2 text-xs font-semibold text-[var(--text-strong)] hover:bg-[var(--surface-control)]"
                        title={session.fullName}
                      >
                        <span className="truncate">{session.fullName}</span>
                      </Badge>
                      {session.isErrored ? (
                        <span className="session-monitor-error-badge inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none">
                          <AlertCircle className="h-3 w-3" />
                          {t('hubMonitor.failed')}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <span className="mr-0.5 shrink-0 text-[11px] text-muted-foreground">
                        {formatTimeAgo(session.updatedAt)}
                      </span>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded-full bg-transparent text-[var(--primary-control-foreground)] hover:bg-transparent hover:text-[var(--primary-control-foreground)]"
                            aria-label={t('hubMonitor.moveToExecutionArea')}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenInExecutionArea(session);
                            }}
                          >
                            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#E5E5E6] transition-opacity hover:opacity-90 motion-reduce:transition-none dark:bg-[var(--switch-checked-track)]">
                              <ArrowRight
                                className="h-3 w-3"
                                strokeWidth={3.25}
                              />
                            </span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {canUseRightPanelForSessions
                            ? t('hubMonitor.moveToExecutionArea')
                            : t('hubMonitor.openInExecutionArea')}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                            aria-label={t('hubMonitor.cancelMonitor')}
                            onClick={(event) => {
                              event.stopPropagation();
                              onCancelMonitor(session);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t('hubMonitor.cancelMonitor')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-background">
                    <KanbanSessionConversationView
                      workspaceId={session.workspace.id}
                      sessionId={session.id}
                      className="h-full"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
