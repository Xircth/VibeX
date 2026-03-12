import { ChevronsRight, Hand, ListTodo, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type PermissionMode = 'auto' | 'ask' | 'plan';

interface PermissionSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  className?: string;
  modes?: PermissionMode[];
}

const MODES = [
  { value: 'auto' as const, label: '自动', icon: ChevronsRight },
  { value: 'ask' as const, label: '询问', icon: Hand },
  { value: 'plan' as const, label: '计划', icon: ListTodo },
] as const;

export function PermissionSelector({
  value,
  onChange,
  disabled,
  className,
  modes,
}: PermissionSelectorProps) {
  const availableModes = modes
    ? MODES.filter((mode) => modes.includes(mode.value))
    : MODES;
  const current = availableModes.find((m) => m.value === value) ?? availableModes[0] ?? MODES[1];
  const Icon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn('px-2 flex items-center gap-1', className)}
          disabled={disabled}
        >
          <Icon className="h-3 w-3" />
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top">
        {availableModes.map((mode) => {
          const ModeIcon = mode.icon;
          return (
            <DropdownMenuItem
              key={mode.value}
              onClick={() => onChange(mode.value)}
              className={value === mode.value ? 'bg-accent' : ''}
            >
              <ModeIcon className="h-3.5 w-3.5 mr-2" />
              {mode.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
