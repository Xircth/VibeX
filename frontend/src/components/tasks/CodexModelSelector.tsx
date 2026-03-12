import { Brain, ChevronDown } from 'lucide-react';
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
}

export function CodexModelSelector({
  value,
  options,
  onChange,
  disabled,
  className,
}: CodexModelSelectorProps) {
  const current = options.find((option) => option.value === value) ?? options[0] ?? {
    value: null,
    label: '默认',
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn('px-2 flex items-center gap-1', className)}
          disabled={disabled}
        >
          <span className="text-xs truncate max-w-[140px]">{current.label}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
        <DropdownMenuLabel>模型</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value ?? 'DEFAULT'}
            onClick={() => onChange(option.value)}
            className={value === option.value ? 'bg-accent' : ''}
          >
            <span className="flex items-center gap-2">
              <Brain className="h-3.5 w-3.5" />
              {option.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
