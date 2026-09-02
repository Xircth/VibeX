import { useTranslation } from 'react-i18next';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { cn } from '@/lib/utils';
import { SessionMonitorCard } from './SessionMonitorCard';
import { getMonitorGridClassName, getMonitorItemClassName } from './utils';

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
                    'flex min-h-0 flex-col overflow-hidden',
                    getMonitorItemClassName(monitorRecords.length, index)
                  )}
                >
                  <SessionMonitorCard
                    session={session}
                    variant="monitor"
                    slotIndex={index}
                    canUseRightPanelForSessions={canUseRightPanelForSessions}
                    onMoveToExecution={onOpenInExecutionArea}
                    onClose={onCancelMonitor}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
