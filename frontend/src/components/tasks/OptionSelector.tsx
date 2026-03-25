import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface OptionSelectorOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
}

interface OptionSelectorProps<T extends string> {
  value: T;
  options: ReadonlyArray<OptionSelectorOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  menuLabel?: string;
  placeholder?: string;
  iconOnly?: boolean;
}

export function OptionSelector<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
  menuLabel,
  placeholder = 'Select',
  iconOnly = false,
}: OptionSelectorProps<T>) {
  const current =
    options.find((option) => option.value === value) ?? options[0] ?? null;
  const CurrentIcon = current?.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={iconOnly ? 'ghost' : 'secondary'}
          size="sm"
          className={cn(
            iconOnly
              ? 'h-7 w-7 px-0 border-0 shadow-none justify-center'
              : 'px-2 flex items-center gap-1',
            className
          )}
          disabled={disabled}
          title={current?.label ?? placeholder}
        >
          {CurrentIcon ? <CurrentIcon className="h-3 w-3" /> : null}
          {!iconOnly ? (
            <span className="text-xs truncate max-w-[140px]">
              {current?.label ?? placeholder}
            </span>
          ) : null}
          {!iconOnly ? <ChevronDown className="h-2.5 w-2.5" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
        {menuLabel ? <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel> : null}
        {options.map((option) => {
          const Icon = option.icon;

          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onChange(option.value)}
              className={value === option.value ? 'bg-accent' : ''}
            >
              <div className="flex items-start gap-2">
                {Icon ? <Icon className="mt-0.5 h-3.5 w-3.5" /> : null}
                <div className="flex flex-col">
                  <span className="text-xs font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="text-[10px] text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
