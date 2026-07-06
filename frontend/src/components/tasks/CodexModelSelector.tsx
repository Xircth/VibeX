import { ChevronDown, Cpu, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface CodexModelOption {
  value: string | null;
  label: string;
}

interface CodexModelSelectorProps {
  value: string | null;
  options: CodexModelOption[];
  onChange: (model: string | null) => void;
  fastMode?: {
    checked: boolean;
    label: string;
    hint: string;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  };
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

export function CodexModelSelector({
  value,
  options,
  onChange,
  fastMode,
  disabled,
  className,
  iconOnly = false,
  dropdownSide = 'bottom',
}: CodexModelSelectorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const current = options.find((option) => option.value === value) ??
    options[0] ?? {
      value: null,
      label: t('codexModelSelector.defaultLabel'),
    };

  return (
    <DropdownMenu modal={false}>
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
          title={current.label}
        >
          <Cpu className="h-3 w-3" />
          {!iconOnly ? (
            <span className="text-xs truncate max-w-[140px]">
              {current.label}
            </span>
          ) : null}
          {!iconOnly && fastMode?.checked ? (
            <Zap
              className="h-3 w-3 fill-primary text-primary"
              aria-label={fastMode.label}
            />
          ) : null}
          {!iconOnly ? <ChevronDown className="h-2.5 w-2.5" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align="start"
        sideOffset={1}
        avoidCollisions={false}
        className="min-w-[220px]"
      >
        <DropdownMenuLabel>{t('codexModelSelector.modelLabel')}</DropdownMenuLabel>
        {fastMode ? (
          <div className="px-1 pb-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fastMode.checked}
                    aria-label={fastMode.label}
                    disabled={disabled || fastMode.disabled}
                    onClick={(event) => {
                      event.preventDefault();
                      if (disabled || fastMode.disabled) return;
                      fastMode.onCheckedChange(!fastMode.checked);
                    }}
                    className={cn(
                      'flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
                      fastMode.checked &&
                        'bg-[hsl(var(--primary)/0.1)] text-primary hover:bg-[hsl(var(--primary)/0.1)]'
                    )}
                  >
                    <Zap
                      className={cn(
                        'h-3.5 w-3.5',
                        fastMode.checked &&
                          'fill-primary text-primary'
                      )}
                    />
                    <span>{fastMode.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  className="max-w-[240px] text-xs leading-4"
                >
                  {fastMode.hint}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : null}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value ?? 'DEFAULT'}
            onSelect={() => onChange(option.value)}
            className={value === option.value ? 'bg-accent' : ''}
          >
            <span className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5" />
              {option.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
