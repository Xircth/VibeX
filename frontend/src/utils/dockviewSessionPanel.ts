import type { IDockviewPanel } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { PANEL_IDS } from '@/stores/useLayoutStore';

/**
 * Dockview's `inactive: true` skips both panel activation and group
 * activation. With the default `onlyWhenVisible` renderer that leaves an
 * empty session column: the group is on screen, but no panel content is
 * mounted. Open the panel inside its group without making that group the
 * active group, so the editor keeps focus.
 */
export function revealSessionPanelWithoutStealingFocus(
  panel: IDockviewPanel
): void {
  panel.group.model.openPanel(panel, { skipSetGroupActive: true });
}

export function addSessionPanelWithoutStealingFocus(
  api: DockviewApi,
  rightGroup: { id: string }
): IDockviewPanel {
  const existing = api.getPanel(PANEL_IDS.AI_CHAT);
  const panel =
    existing ??
    api.addPanel({
      id: PANEL_IDS.AI_CHAT,
      component: PANEL_IDS.AI_CHAT,
      title: 'Sessions',
      position: {
        referenceGroup: rightGroup.id,
        direction: 'within',
      },
      inactive: true,
    });

  revealSessionPanelWithoutStealingFocus(panel);
  return panel;
}
