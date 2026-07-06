import { AlertCircle, PanelRightOpen, Rows2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Rows2 className="h-4 w-4" />
          <span>{t('hubMonitor.title')}</span>
          {monitorRecords.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {monitorRecords.length} / 4
            </span>
          ) : null}
        </div>

        {monitorRecords.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-[var(--surface-content)] px-6 text-center text-sm text-muted-foreground">
            {t('hubMonitor.emptyHint')}
          </div>
        ) : (
          <div
            className={cn('grid min-h-0 flex-1 gap-4', monitorGridClassName)}
          >
            {monitorRecords.map((session, index) => (
              <div
                key={session.id}
                className={cn(
                  'flex min-h-0 flex-col overflow-hidden rounded-lg border p-3 transition-colors hover:bg-[var(--surface-control-hover)]',
                  // 会话报错时整卡切换为红色错误态边框，覆盖默认 Slot 配色，便于一眼定位出错的监控位。
                  session.isErrored
                    ? 'session-monitor-slot-error'
                    : MONITOR_SLOT_STYLES[index]?.shell,
                  getMonitorItemClassName(monitorRecords.length, index)
                )}
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <div
                        className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
                        title={session.fullName}
                      >
                        {session.fullName}
                      </div>
                      {session.isErrored ? (
                        <span className="session-monitor-error-badge inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none">
                          <AlertCircle className="h-3 w-3" />
                          {t('hubMonitor.failed')}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatTimeAgo(session.updatedAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                          aria-label={t('hubMonitor.moveToExecutionArea')}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenInExecutionArea(session);
                          }}
                        >
                          <PanelRightOpen className="h-3.5 w-3.5" />
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
                      <TooltipContent>{t('hubMonitor.cancelMonitor')}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/50 bg-background/80">
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
    </section>
  );
}
