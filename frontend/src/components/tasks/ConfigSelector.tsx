import { Settings2, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import type { ExecutorProfileId } from 'shared/types';
import { getVariantOptions } from '@/utils/executor';

interface ConfigSelectorProps {
  profiles: Record<string, Record<string, unknown>> | null;
  selectedExecutorProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  showLabel?: boolean;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

export function ConfigSelector({
  profiles,
  selectedExecutorProfile,
  onChange,
  disabled,
  className = '',
  showLabel = false,
  iconOnly = false,
  dropdownSide = 'bottom',
}: ConfigSelectorProps) {
  const selectedAgent = selectedExecutorProfile?.executor;
  const configs = selectedAgent && profiles ? profiles[selectedAgent] : null;
  const configOptions = getVariantOptions(selectedAgent, profiles);
  const selectedVariant = selectedExecutorProfile?.variant || 'DEFAULT';

  if (
    !selectedAgent ||
    !profiles ||
    !configs ||
    Object.keys(configs).length === 0
  ) {
    return null;
  }

  return (
    <div className={iconOnly ? 'shrink-0' : 'flex-1'}>
      {showLabel ? (
        <Label htmlFor="executor-variant" className="text-sm font-medium">
          配置
        </Label>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={iconOnly ? 'ghost' : 'outline'}
            size="sm"
            className={`${iconOnly ? 'h-7 w-7 px-0 justify-center gap-0 border-0 shadow-none' : 'w-full justify-between'} text-xs ${showLabel ? 'mt-1.5' : ''} ${className}`}
            disabled={disabled}
            aria-label="选择配置"
            title={selectedVariant}
          >
            <div className="flex items-center gap-1.5 w-full">
              <Settings2 className="h-3 w-3" />
              {!iconOnly ? (
                <span className="truncate">{selectedVariant}</span>
              ) : null}
            </div>
            {!iconOnly ? <ArrowDown className="h-3 w-3" /> : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={dropdownSide}
          align="start"
          sideOffset={1}
          avoidCollisions={false}
          className="w-60"
        >
          {configOptions.map((variant) => (
            <DropdownMenuItem
              key={variant}
              onSelect={() => {
                onChange({
                  executor: selectedAgent,
                  variant: variant === 'DEFAULT' ? null : variant,
                });
              }}
              className={
                (variant === 'DEFAULT' ? null : variant) ===
                selectedExecutorProfile?.variant
                  ? 'bg-accent'
                  : ''
              }
            >
              {variant}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
