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
      className={cn('inline-flex items-center gap-1.5 text-xs', className)}
    >
      {activeInstance ? (
        <AgentTypeIcon
          agentType={activeInstance.agentId}
          className="h-3.5 w-3.5 shrink-0 text-foreground"
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
        className="raised-control h-7 max-w-[220px] truncate px-2 text-xs font-medium outline-none disabled:opacity-50"
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
