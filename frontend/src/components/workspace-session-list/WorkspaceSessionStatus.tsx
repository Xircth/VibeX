import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { WorkspaceSessionStatusTone } from './workspaceSessionListModel';

export const STATUS_LABEL_KEY: Record<WorkspaceSessionStatusTone, string> = {
  todo: 'workspaceSessionList.statusTodo',
  inprogress: 'workspaceSessionList.statusInProgress',
  inreview: 'workspaceSessionList.statusInReview',
  done: 'workspaceSessionList.statusDone',
};

export function WorkspaceSessionStatusIndicator({
  tone,
  className,
}: {
  tone: WorkspaceSessionStatusTone;
  className?: string;
}) {
  return tone === 'inprogress' ? (
    <Loader2
      className={cn(
        'workspace-session-status workspace-session-status--inprogress h-3 w-3 shrink-0 animate-spin',
        className
      )}
      aria-hidden="true"
    />
  ) : (
    <span
      className={cn(
        'workspace-session-status',
        `workspace-session-status--${tone}`,
        className
      )}
      aria-hidden="true"
    />
  );
}

export function WorkspaceSessionStatusLabel({
  tone,
}: {
  tone: WorkspaceSessionStatusTone;
}) {
  const { t } = useTranslation('panels');
  return (
    <span className="workspace-session-status-label" data-status={tone}>
      <WorkspaceSessionStatusIndicator tone={tone} />
      <span>{t(STATUS_LABEL_KEY[tone])}</span>
    </span>
  );
}
