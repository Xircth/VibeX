import { useMemo } from 'react';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import {
  buildSessionCardMenuItems,
  type BuildSessionCardMenuItemsParams,
} from './sessionCardMenu';

export interface SessionCardContextMenuProps
  extends Omit<BuildSessionCardMenuItemsParams, 'forkAgents'> {
  x: number;
  y: number;
  onClose: () => void;
}

export function SessionCardContextMenu({
  x,
  y,
  onClose,
  ...menuParams
}: SessionCardContextMenuProps) {
  const selectableAgents = useSelectableAgents();
  const forkAgents = useMemo(
    () => selectableAgents.filter(isEnabledInstalledAgent),
    [selectableAgents]
  );

  const items = buildSessionCardMenuItems({
    ...menuParams,
    forkAgents,
  });

  return <ProductContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
