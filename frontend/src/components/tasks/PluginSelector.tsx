import { memo } from 'react';
import { useTranslation } from 'react-i18next';
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

interface PluginSelectorProps {
  value: string | null;
  onChange: (plugin: string | null) => void;
  disabled?: boolean;
  className?: string;
}

function PluginSelectorInner({
  value,
  onChange,
  disabled,
  className,
}: PluginSelectorProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useClaudeSettings();
  const pluginsMap = settings?.enabled_plugins ?? {};
  const plugins = Object.entries(pluginsMap)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  const displayName = value ?? t('pluginSelector.default');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn('px-2 flex items-center gap-1', className)}
          disabled={disabled}
        >
          <span className="text-xs truncate max-w-[80px]">{displayName}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={1}
        avoidCollisions={false}
      >
        <DropdownMenuItem
          onClick={() => onChange(null)}
          className={value === null ? 'bg-accent' : ''}
        >
          {t('pluginSelector.default')}
        </DropdownMenuItem>
        {plugins.map((plugin) => (
          <DropdownMenuItem
            key={plugin}
            onClick={() => onChange(plugin)}
            className={value === plugin ? 'bg-accent' : ''}
          >
            {plugin}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

PluginSelectorInner.displayName = 'PluginSelector';
export const PluginSelector = memo(PluginSelectorInner);
