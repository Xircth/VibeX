import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SessionItem {
  id: string;
  displayName: string;
  statusLabel: string;
}

interface SessionSelectorProps {
  sessions: SessionItem[];
  selectedSessionId?: string;
  compactSessionLabel: string;
  selectedSessionLabel: string;
  onSelectSession: (id: string) => void;
  onStartNewSession: () => void;
}

export function SessionSelector({
  sessions,
  selectedSessionId,
  compactSessionLabel,
  selectedSessionLabel,
  onSelectSession,
  onStartNewSession,
}: SessionSelectorProps) {
  if (sessions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          title={selectedSessionLabel}
        >
          <Badge
            variant="outline"
            className="max-w-[96px] rounded-md border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          >
            <span className="truncate">{compactSessionLabel}</span>
          </Badge>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sessions.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className={selectedSessionId === s.id ? 'bg-accent' : ''}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate max-w-[180px]">{s.displayName}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {s.statusLabel}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={onStartNewSession}>
          {`+ 新建 session${sessions.length + 1}`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
