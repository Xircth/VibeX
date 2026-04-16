import { ChevronDown, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface CodexModelOption {
  value: string | null;
  label: string;
}

interface CodexModelSelectorProps {
  value: string | null;
  options: CodexModelOption[];
  onChange: (model: string | null) => void;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

export function CodexModelSelector({
  value,
  options,
  onChange,
  disabled,
  className,
  iconOnly = false,
  dropdownSide = 'bottom',
}: CodexModelSelectorProps) {
  const current = options.find((option) => option.value === value) ??
    options[0] ?? {
      value: null,
      label: '默认',
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
        <DropdownMenuLabel>模型</DropdownMenuLabel>
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
