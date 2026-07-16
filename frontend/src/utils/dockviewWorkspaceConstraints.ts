import type { DockviewApi } from 'dockview-react';
import { GROUP_IDS, MIN_RIGHT_PANEL_WIDTH } from '@/stores/useLayoutStore';
import {
  isLeftGroup,
  isSessionGroup,
} from '@/utils/dockviewGroupPolicy';

export const MIN_LEFT_PANEL_WIDTH = 200;

/**
 * Dockview does not serialize group constraints. Re-apply them immediately
 * after every restore/normalization so a saved layout can never reopen with
 * an unusable A or C zone.
 */
export function applyWorkspaceZoneConstraints(api: DockviewApi) {
  const leftGroup =
    api.getGroup(GROUP_IDS.LEFT) ??
    api.groups.find((group) => isLeftGroup(group));
  leftGroup?.api.setConstraints({ minimumWidth: MIN_LEFT_PANEL_WIDTH });

  const rightGroup =
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group));
  rightGroup?.api.setConstraints({ minimumWidth: MIN_RIGHT_PANEL_WIDTH });
}
