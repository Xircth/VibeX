import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import type { AgentInstanceOption } from '@/lib/providerInstancesApi';
import { cn } from '@/lib/utils';

export interface SessionInstanceSelectorProps {
  options: AgentInstanceOption[];
  selectedInstanceId: string;
  onSelectInstance: (instanceId: string) => void;
  disabled?: boolean;
  dropdownSide?: 'top' | 'bottom';
  className?: string;
}

export function SessionInstanceSelector({
  options,
  selectedInstanceId,
  onSelectInstance,
  disabled = false,
  dropdownSide = 'bottom',
  className,
}: SessionInstanceSelectorProps) {
  const { t } = useTranslation(['tasks', 'settings']);
  if (options.length < 2) {
    return null;
  }

  const active =
    options.find((option) => option.instanceId === selectedInstanceId) ??
    options[0];

  return (
    <div
      className={cn('space-y-1.5', className)}
      data-testid="session-instance-selector"
    >
      <Label className="text-xs font-medium">
        {t('tasks:sessionCreation.instanceLabel', { defaultValue: '实例' })}
      </Label>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid="session-instance-selector-trigger"
            className="h-9 w-full justify-between px-3 text-xs font-normal"
          >
            <span className="truncate">{active.displayName}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={dropdownSide}
          align="start"
          className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
        >
          {options.map((option) => {
            const isSelected = option.instanceId === active.instanceId;
            return (
              <DropdownMenuItem
                key={option.instanceId}
                data-testid={`session-instance-option-${option.instanceId}`}
                onSelect={() => onSelectInstance(option.instanceId)}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isSelected ? 'opacity-100' : 'opacity-0'
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{option.displayName}</span>
                </span>
                {option.isDefault ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {t('settings:providerInstances.defaultBadge', {
                      defaultValue: '默认',
                    })}
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
