import { useTranslation } from 'react-i18next';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import {
  formatProviderInstanceOptionLabel,
  type ProviderInstanceConfig,
} from '@/lib/providerInstancesApi';
import { cn } from '@/lib/utils';

export interface ProviderInstanceSelectorProps {
  instances: ReadonlyArray<ProviderInstanceConfig>;
  selectedInstanceId: string | null | undefined;
  onSelectInstance: (instance: ProviderInstanceConfig) => void;
  disabled?: boolean;
  className?: string;
}

export function ProviderInstanceSelector({
  instances,
  selectedInstanceId,
  onSelectInstance,
  disabled = false,
  className,
}: ProviderInstanceSelectorProps) {
  const { t } = useTranslation(['settings']);

  if (instances.length === 0) {
    return null;
  }

  const activeInstance =
    instances.find((item) => item.instanceId === selectedInstanceId) ??
    instances.find((item) => item.isDefault) ??
    instances[0];

  return (
    <div
      data-testid="provider-instance-selector"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/80 px-2.5 text-sm',
        className
      )}
    >
      {activeInstance ? (
        <AgentTypeIcon
          agentType={activeInstance.agentId}
          className="h-4 w-4 shrink-0 text-foreground"
        />
      ) : null}
      <select
        value={activeInstance?.instanceId ?? ''}
        disabled={disabled}
        aria-label={t('settings:providerInstances.selectorAria')}
        data-testid="provider-instance-select"
        onChange={(event) => {
          const next = instances.find(
            (item) => item.instanceId === event.target.value
          );
          if (next && next.instanceId !== activeInstance?.instanceId) {
            onSelectInstance(next);
          }
        }}
        className="h-7 max-w-[220px] truncate bg-transparent text-sm font-medium text-foreground outline-none disabled:opacity-50"
      >
        {instances.map((instance) => (
          <option key={instance.instanceId} value={instance.instanceId}>
            {formatProviderInstanceOptionLabel(instance)}
          </option>
        ))}
      </select>
    </div>
  );
}
