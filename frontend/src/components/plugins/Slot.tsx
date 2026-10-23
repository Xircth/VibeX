import {
  useSlotContributions,
  type SlotContribution,
  type SlotName,
} from '@vibex/plugin-sdk';
import type { ReactNode } from 'react';

import {
  isPluginQuarantined,
  PluginBoundary,
} from '@/components/plugins/PluginBoundary';

export interface SlotProps {
  name: SlotName;
  slotProps?: Record<string, unknown>;
  className?: string;
  itemClassName?: string;
  emptyFallback?: ReactNode;
  filter?: (contribution: SlotContribution) => boolean;
}

export function Slot({
  name,
  slotProps,
  className,
  itemClassName,
  emptyFallback = null,
  filter,
}: SlotProps): ReactNode {
  const contributions = useSlotContributions(name);
  const visible = contributions.filter(
    (item) =>
      !isPluginQuarantined(item.pluginId ?? 'builtin') &&
      (filter ? filter(item) : true)
  );

  if (visible.length === 0) {
    return emptyFallback;
  }

  const items = visible.map((item) => {
    const Component = item.component;
    const ownerPluginId = item.pluginId ?? 'builtin';
    if (!Component) {
      return null;
    }
    const node = (
      <PluginBoundary key={item.id} pluginId={ownerPluginId} slot={name}>
        <Component
          {...(slotProps ?? {})}
          pluginId={ownerPluginId}
          contributionId={item.id}
        />
      </PluginBoundary>
    );
    return itemClassName ? (
      <div key={item.id} className={itemClassName}>
        {node}
      </div>
    ) : (
      node
    );
  });

  if (className) {
    return (
      <div className={className} data-slot-name={name}>
        {items}
      </div>
    );
  }

  return <>{items}</>;
}
