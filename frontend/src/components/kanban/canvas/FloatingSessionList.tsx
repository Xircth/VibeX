import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface FloatingSessionListProps {
  collapsed: boolean;
  width: number;
  children: ReactNode;
}

export function FloatingSessionList({
  collapsed,
  width,
  children,
}: FloatingSessionListProps) {
  if (collapsed) {
    return null;
  }

  return (
    <div
      className={cn(
        'session-canvas-floating-panel absolute bottom-3 left-3 top-3 z-20 flex min-h-0',
        'overflow-hidden rounded-xl border border-border',
        'shadow-[var(--shadow-popover)]'
      )}
      style={{ width }}
    >
      <div className="session-canvas-floating-list relative flex min-h-0 min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}
