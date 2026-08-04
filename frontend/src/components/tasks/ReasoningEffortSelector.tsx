import { Brain, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ReasoningEffortOption {
  value: CodexReasoningEffort;
  label: string;
  description: string;
}

export const CODEX_REASONING_EFFORT_OPTIONS: ReadonlyArray<ReasoningEffortOption> =
  [
    {
      value: 'low',
      label: 'Low',
      description: 'reasoningEffortSelector.lowDescription',
    },
    {
      value: 'medium',
      label: 'Medium',
      description: 'reasoningEffortSelector.mediumDescription',
    },
    {
      value: 'high',
      label: 'High',
      description: 'reasoningEffortSelector.highDescription',
    },
    {
      value: 'xhigh',
      label: 'Extra High',
      description: 'reasoningEffortSelector.xhighDescription',
    },
  ];

export const CODEX_DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'high';

interface ReasoningEffortSelectorProps {
  value: CodexReasoningEffort;
  onChange: (effort: CodexReasoningEffort) => void;
  disabled?: boolean;
  className?: string;
}

export function ReasoningEffortSelector({
  value,
  onChange,
  disabled,
  className,
}: ReasoningEffortSelectorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const current =
    CODEX_REASONING_EFFORT_OPTIONS.find((opt) => opt.value === value) ??
    CODEX_REASONING_EFFORT_OPTIONS[2]; // Default to 'high'

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn('px-2 flex items-center gap-1', className)}
          disabled={disabled}
        >
          <Brain className="h-3 w-3" />
          <span className="text-xs truncate max-w-[80px]">{current.label}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={1}
        avoidCollisions={false}
        className="min-w-[200px]"
      >
        <DropdownMenuLabel>
          {t('reasoningEffortSelector.title')}
        </DropdownMenuLabel>
        {CODEX_REASONING_EFFORT_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className={value === option.value ? 'bg-accent' : ''}
          >
            <div className="flex flex-col">
              <span className="text-xs font-medium">{option.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {t(option.description)}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
