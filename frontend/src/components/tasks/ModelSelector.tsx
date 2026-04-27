import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useClaudeSettings } from '@/hooks/useClaudeSettings';

const MODEL_CHOICES = [
  { key: 'sonnet', label: 'Sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { key: 'opus', label: 'Opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
  { key: 'haiku', label: 'Haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
] as const;

export type ModelKey = (typeof MODEL_CHOICES)[number]['key'];

interface ModelSelectorProps {
  value: ModelKey;
  onChange: (model: ModelKey) => void;
  disabled?: boolean;
  className?: string;
}

function ModelSelectorInner({
  value,
  onChange,
  disabled,
  className,
}: ModelSelectorProps) {
  const { settings } = useClaudeSettings();
  const env = settings?.env ?? {};

  const currentLabel =
    MODEL_CHOICES.find((model) => model.key === value)?.label ?? 'Sonnet';

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn('px-2 flex items-center gap-1', className)}
          disabled={disabled}
        >
          <span className="text-xs">{currentLabel}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={1}
        avoidCollisions={false}
      >
        {MODEL_CHOICES.map((model) => {
          const modelId = env[model.envKey];
          return (
            <DropdownMenuItem
              key={model.key}
              onSelect={() => onChange(model.key)}
              className={value === model.key ? 'bg-accent' : ''}
            >
              <span>{model.label}</span>
              {modelId && (
                <span className="ml-2 text-muted-foreground text-[10px]">
                  {modelId}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

ModelSelectorInner.displayName = 'ModelSelector';
export const ModelSelector = memo(ModelSelectorInner);
