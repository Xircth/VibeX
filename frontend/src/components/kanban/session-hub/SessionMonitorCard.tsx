import { AlertCircle, ArrowRight, Scaling, X } from 'lucide-react';
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
import { DRAG_HANDLE_CLASS } from '@/components/kanban/canvas/canvasModel';
import { MONITOR_SLOT_STYLES, formatTimeAgo } from './utils';

export type SessionMonitorCardVariant = 'monitor' | 'canvas';

interface SessionMonitorCardProps {
  session: KanbanProjectSessionRecord;
  variant?: SessionMonitorCardVariant;
  selected?: boolean;
  slotIndex?: number;
  canUseRightPanelForSessions?: boolean;
  onMoveToExecution?: (session: KanbanProjectSessionRecord) => void;
  onZoom?: (session: KanbanProjectSessionRecord) => void;
  onClose: (session: KanbanProjectSessionRecord) => void;
}

export function SessionMonitorCard({
  session,
  variant = 'monitor',
  selected = false,
  slotIndex = 0,
  canUseRightPanelForSessions = false,
  onMoveToExecution,
  onZoom,
  onClose,
}: SessionMonitorCardProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const isCanvas = variant === 'canvas';
  const primaryAction = isCanvas ? onZoom : onMoveToExecution;
  const primaryLabel = isCanvas
    ? t('hubCanvas.resetCardSize')
    : canUseRightPanelForSessions
      ? t('hubMonitor.moveToExecutionArea')
      : t('hubMonitor.openInExecutionArea');
  const closeLabel = isCanvas
    ? t('hubCanvas.collapseCard')
    : t('hubMonitor.cancelMonitor');

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border bg-[var(--surface-card-strong)] transition-colors',
        isCanvas
          ? cn('canvas-session-window', selected && 'is-selected')
          : session.isErrored
            ? 'session-monitor-slot-error hover:bg-[var(--surface-control-hover)]'
            : cn(
                MONITOR_SLOT_STYLES[slotIndex]?.shell,
                'hover:bg-[var(--surface-control-hover)]'
              )
      )}
    >
      <div
        className={cn(
          'flex h-8 shrink-0 items-center justify-between gap-2 px-2.5',
          isCanvas && `${DRAG_HANDLE_CLASS} cursor-grab active:cursor-grabbing`
        )}
        onDoubleClick={(event) => {
          if (!isCanvas) return;
          event.stopPropagation();
          onClose(session);
        }}
      >
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

          {primaryAction ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={isCanvas ? 'secondary' : 'ghost'}
                  size="icon"
                  className={
                    isCanvas
                      ? 'nodrag nopan h-7 w-7 text-[var(--text-strong)]'
                      : 'nodrag nopan h-6 w-6 rounded-full bg-transparent text-[var(--primary-control-foreground)] hover:bg-transparent hover:text-[var(--primary-control-foreground)]'
                  }
                  aria-label={primaryLabel}
                  onClick={(event) => {
                    event.stopPropagation();
                    primaryAction(session);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  {isCanvas ? (
                    <Scaling className="h-3.5 w-3.5" strokeWidth={2.25} />
                  ) : (
                    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--surface-control)] transition-opacity hover:opacity-90 motion-reduce:transition-none dark:bg-[var(--switch-checked-track)]">
                      <ArrowRight className="h-3 w-3" strokeWidth={3.25} />
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{primaryLabel}</TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-6 w-6 rounded-full text-muted-foreground hover:bg-background/40 hover:text-foreground"
                aria-label={closeLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(session);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{closeLabel}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="nowheel nopan min-h-0 flex-1 overflow-hidden rounded-xl bg-background">
        <KanbanSessionConversationView
          workspaceId={session.workspace.id}
          sessionId={session.id}
          interactive={isCanvas}
          className="h-full"
        />
      </div>
    </div>
  );
}
