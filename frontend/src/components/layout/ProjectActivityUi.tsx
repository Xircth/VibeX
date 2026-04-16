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
  style,
}: {
  projectName: string;
  recentSessions: ProjectRecentSessionSnapshot[];
  align?: 'right' | 'top';
  style?: React.CSSProperties;
}) {
  if (recentSessions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'z-50 min-w-72 rounded-lg border border-border bg-popover p-2 shadow-xl pointer-events-none',
        align === 'right' ? 'fixed' : 'absolute bottom-7 left-0'
      )}
      style={style}
    >
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
        {projectName} · 最近会话
      </div>
      <div className="space-y-1.5">
        {recentSessions.map((session) => (
          <div
            key={session.sessionId}
            className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
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
              <span className="ml-auto text-[10px] text-muted-foreground">
                {session.statusLabel}
              </span>
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {session.subtitle}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
