import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { AgentSessionMode } from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Composer mode picker, driven entirely by the modes the agent actually
 * advertised for this conversation (`session_mode_updated`). Selecting a mode
 * applies it on the next turn via the real ACP `SetSessionMode`. Renders nothing
 * until the agent advertises modes, so it never shows fabricated options.
 */
export function SessionModeSelector({
  modes,
  current,
  selected,
  onSelect,
  disabled = false,
}: {
  modes: AgentSessionMode[];
  /** The agent's currently-active mode id (from the stream). */
  current: string | null;
  /** The user's pending selection for the next turn, if any. */
  selected: string | null;
  onSelect: (modeId: string) => void;
  disabled?: boolean;
}) {
  if (modes.length === 0) return null;

  const activeId = selected ?? current;
  const activeMode = modes.find((mode) => mode.id === activeId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground/80',
          'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
        )}
        title="会话模式"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span className="max-w-[10rem] truncate">
          {activeMode?.label ?? '模式'}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {modes.map((mode) => (
          <DropdownMenuItem
            key={mode.id}
            onSelect={() => onSelect(mode.id)}
            className="flex items-start gap-2"
          >
            <Check
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
                mode.id === activeId ? 'opacity-100' : 'opacity-0'
              )}
            />
            <span className="min-w-0">
              <span className="block truncate">{mode.label}</span>
              {mode.description ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {mode.description}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
