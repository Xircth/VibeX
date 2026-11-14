import type { DockviewApi } from 'dockview-react';
import { GROUP_IDS, MIN_RIGHT_PANEL_WIDTH } from '@/stores/useLayoutStore';
import {
  isLeftGroup,
  isSessionGroup,
  listLeftDockGroups,
} from '@/utils/dockviewGroupPolicy';

export const MIN_LEFT_PANEL_WIDTH = 200;

/**
 * Dockview does not serialize group constraints. Re-apply them immediately
 * after every restore/normalization so a saved layout can never reopen with
 * an unusable A or C zone.
 */
export function applyWorkspaceZoneConstraints(
  api: DockviewApi,
  availableWidth = api.width
) {
  const sideWidthBudget = Math.max(0, availableWidth - 320);
  const minimumLeftWidth = Math.min(
    MIN_LEFT_PANEL_WIDTH,
    Math.max(120, Math.floor(sideWidthBudget * 0.25))
  );
  const minimumRightWidth = Math.min(
    MIN_RIGHT_PANEL_WIDTH,
    Math.max(240, Math.floor(sideWidthBudget * 0.5))
  );
  const leftGroups = new Set([
    ...listLeftDockGroups(api.groups),
    ...(api.getGroup(GROUP_IDS.LEFT) ? [api.getGroup(GROUP_IDS.LEFT)!] : []),
    ...api.groups.filter((group) => isLeftGroup(group)),
  ]);
  for (const leftGroup of leftGroups) {
    leftGroup.api.setConstraints({ minimumWidth: minimumLeftWidth });
  }

  const rightGroup =
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group));
  rightGroup?.api.setConstraints({ minimumWidth: minimumRightWidth });
}
