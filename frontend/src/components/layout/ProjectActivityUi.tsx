import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ProjectActivityAlert,
  ProjectActivitySnapshot,
  ProjectActivityVisualState,
  ProjectRecentSessionSnapshot,
} from '@/stores/useWindowProjectsStore';

export function deriveProjectVisualState(
  snapshot: ProjectActivitySnapshot,
  alert?: ProjectActivityAlert
): ProjectActivityVisualState {
  if (snapshot.isLoading || snapshot.hasRunning) {
    return 'loading';
  }

  if (alert?.kind === 'error' && alert.unread) {
    return 'error-unread';
  }

  if (snapshot.hasError) {
    return 'error';
  }

  if (alert?.kind === 'success' && alert.unread) {
    return 'success-unread';
  }

  if (snapshot.hasSessions) {
    return 'success';
  }

  return 'idle';
}

export function resolveProjectVisualStateMeta(
  visualState: ProjectActivityVisualState
): {
  label: string;
  dotClassName: string;
  pulseClassName?: string;
} {
  switch (visualState) {
    case 'loading':
      return {
        label: 'Loading',
        dotClassName: 'text-primary',
      };
    case 'success-unread':
      return {
        label: '有刚完成未查看的会话',
        dotClassName: 'bg-emerald-500',
        pulseClassName: 'animate-pulse',
      };
    case 'success':
      return {
        label: '所有会话已完成且已查看',
        dotClassName: 'bg-emerald-500',
      };
    case 'error-unread':
      return {
        label: '会话执行报错需查看',
        dotClassName: 'bg-red-500',
        pulseClassName: 'animate-pulse',
      };
    case 'error':
      return {
        label: '会话报错已查看',
        dotClassName: 'bg-red-500',
      };
    default:
      return {
        label: '暂无会话',
        dotClassName: 'bg-muted-foreground/60',
      };
  }
}

export function ProjectRecentSessionsPopover({
  projectName,
  recentSessions,
  align = 'right',
}: {
  projectName: string;
  recentSessions: ProjectRecentSessionSnapshot[];
  align?: 'right' | 'top';
}) {
  if (recentSessions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'z-50 min-w-[300px] rounded-2xl border border-border/80 bg-popover/95 p-2.5 shadow-2xl backdrop-blur-md',
        align === 'right'
          ? 'absolute left-14 top-1/2 -translate-y-1/2'
          : 'absolute bottom-7 left-0'
      )}
    >
      <div className="mb-2 flex items-center gap-2 border-b border-border/70 px-1 pb-2 text-[11px] font-medium text-muted-foreground">
        <span className="h-2 w-2 rounded-full bg-primary/80" />
        {projectName} · 最近会话
      </div>
      <div className="space-y-1.5">
        {recentSessions.map((session) => (
          <div
            key={session.sessionId}
            className="rounded-xl border border-border/60 bg-background/70 px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              {session.visualState === 'loading' ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    session.visualState === 'error'
                      ? 'bg-red-500'
                      : session.visualState === 'success'
                        ? 'bg-emerald-500'
                        : 'bg-muted-foreground/60'
                  )}
                />
              )}
              <span className="truncate text-[11px] font-medium">
                {session.title}
              </span>
              <span className="ml-auto rounded-full bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {session.statusLabel}
              </span>
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground/90">
              {session.subtitle}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
