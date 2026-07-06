import { ChevronsRight, Hand, ListTodo, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  {
    value: 'auto' as const,
    labelKey: 'permissionSelector.auto',
    icon: ChevronsRight,
  },
  { value: 'ask' as const, labelKey: 'permissionSelector.ask', icon: Hand },
  { value: 'plan' as const, labelKey: 'permissionSelector.plan', icon: ListTodo },
] as const;

export function PermissionSelector({
  value,
  onChange,
  disabled,
  className,
  modes,
}: PermissionSelectorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const availableModes = modes
    ? MODES.filter((mode) => modes.includes(mode.value))
    : MODES;
  const current =
    availableModes.find((mode) => mode.value === value) ??
    availableModes[0] ??
    MODES[1];
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
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={1}
        avoidCollisions={false}
      >
        {availableModes.map((mode) => {
          const ModeIcon = mode.icon;
          return (
            <DropdownMenuItem
              key={mode.value}
              onClick={() => onChange(mode.value)}
              className={value === mode.value ? 'bg-accent' : ''}
            >
              <ModeIcon className="h-3.5 w-3.5 mr-2" />
              {t(mode.labelKey)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
