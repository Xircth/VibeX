import { PanelRightOpen, Rows2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { createSessionSnapshot } from '@/components/kanban/sessionSnapshot';
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
}

export function SessionHubMonitor({
  monitorRecords,
  canUseRightPanelForSessions,
  onOpenInExecutionArea,
}: SessionHubMonitorProps) {
  const monitorGridClassName = getMonitorGridClassName(monitorRecords.length);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col p-4 pt-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Rows2 className="h-4 w-4" />
          <span>会话监控区</span>
          {monitorRecords.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {monitorRecords.length} / 4
            </span>
          ) : null}
        </div>

        {monitorRecords.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-muted/10 px-6 text-center text-sm text-muted-foreground">
            点击左侧会话即可在右侧栏或监控区中展开；
          </div>
        ) : (
          <div
            className={cn('grid min-h-0 flex-1 gap-4', monitorGridClassName)}
          >
            {monitorRecords.map((session, index) => (
              <div
                key={session.id}
                className={cn(
                  'flex min-h-0 flex-col overflow-hidden rounded-2xl border p-3 shadow-sm transition-colors hover:bg-background/30',
                  MONITOR_SLOT_STYLES[index]?.shell,
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
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatTimeAgo(session.updatedAt)}
                      </span>
                    </div>
                  </div>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                        aria-label="移入执行区"
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
                        ? '移入执行区'
                        : '在执行区打开'}
                    </TooltipContent>
                  </Tooltip>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/50 bg-background/80">
                  <KanbanSessionConversationView
                    workspaceId={session.workspace.id}
                    sessionId={session.id}
                    initialWorkspace={session.workspace}
                    initialSession={createSessionSnapshot(session)}
                    initialTask={session.task}
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
