import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatCountdownTimer } from '@/components/tasks/follow-up/MessageQueueIndicator';
import { cn } from '@/lib/utils';

export function DelayedMessageCountdown({ deliverAt }: { deliverAt: string }) {
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    setTickNow(Date.now());
    const intervalId = window.setInterval(() => {
      setTickNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [deliverAt]);
  return <span>{formatCountdownTimer(deliverAt, tickNow)}</span>;
}

export type CollaborationSelectOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export function CollaborationOptionSelect<T extends string = string>({
  ariaLabel,
  value,
  placeholder,
  options,
  onChange,
  size = 'default',
  disabled = false,
}: {
  ariaLabel: string;
  value: T;
  placeholder?: string;
  options: readonly CollaborationSelectOption<T>[];
  onChange: (value: T) => void;
  size?: 'default' | 'compact';
  disabled?: boolean;
}) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          data-value={value}
          disabled={disabled}
          className={cn(
            'raised-control w-full justify-between px-2.5 font-normal',
            size === 'compact' ? 'h-7 text-xs' : 'h-8 text-[13px]'
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selectedOption?.icon ? (
              <span aria-hidden="true" className="inline-flex shrink-0">
                {selectedOption.icon}
              </span>
            ) : null}
            <span className="truncate">
              {selectedOption?.label || placeholder || ''}
            </span>
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value || '__empty__'}
              data-state={isSelected ? 'checked' : undefined}
              onSelect={() => onChange(option.value)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                {option.icon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {option.icon}
                  </span>
                ) : null}
                <span className="truncate">{option.label}</span>
              </span>
              {isSelected ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
