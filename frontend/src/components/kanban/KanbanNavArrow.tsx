import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface KanbanNavArrowProps {
  side: 'left' | 'right';
  label: string;
  onClick: () => void;
}

export function KanbanNavArrow({ side, label, onClick }: KanbanNavArrowProps) {
  const Icon = side === 'left' ? ChevronsLeft : ChevronsRight;

  return (
    <div
      data-kanban-nav={side}
      className={cn(
        'pointer-events-none absolute inset-y-0 z-30 flex items-center',
        side === 'left' ? 'left-0' : 'right-0'
      )}
    >
      <button
        type="button"
        data-side={side}
        onClick={onClick}
        aria-label={label}
        className="kanban-nav-arrow"
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
