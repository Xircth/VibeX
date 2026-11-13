import type { DockviewApi } from 'dockview-react';
import {
  isLeftGroup,
  isLeftShellNavGroup,
  isEditorGroup,
  isSessionGroup,
  LEFT_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';
import { settleDockviewGroupWidths } from '@/utils/dockviewStartupSizing';

/** Capture before Dockview removes the empty group and redistributes its width. */
export function createLeftDockPanelLifecycle(api: DockviewApi) {
  type Group = DockviewApi['groups'][number];
  const opened = new Set<string>();
  const normalizeRestoredSlots = () => {
    // Older layouts kept every activity-rail selection as a hidden tab.
    // A dock split now holds just its visible panel.
    for (const group of api.groups) {
      const active = group.activePanel;
      if (
        !isLeftShellNavGroup(group) ||
        !active ||
        !LEFT_PANEL_IDS.has(active.id)
      )
        continue;
      for (const panel of [...group.panels]) {
        if (panel !== active && LEFT_PANEL_IDS.has(panel.id))
          api.removePanel(panel);
      }
    }
    opened.clear();
    for (const panel of api.panels) {
      if (LEFT_PANEL_IDS.has(panel.id)) opened.add(panel.id);
    }
  };
  normalizeRestoredSlots();
  const pending = new Map<Group, Array<{ group: Group; width: number }>>();
  const panelAddition = api.onDidAddPanel((panel) => {
    pending.delete(panel.group);
    if (LEFT_PANEL_IDS.has(panel.id)) opened.add(panel.id);
  });
  const panelRemoval = api.onDidRemovePanel((panel) => {
    opened.delete(panel.id);
    const removed = panel.group;
    if (!isLeftGroup(removed) || removed.panels.length > 0) return;
    pending.set(
      removed,
      api.groups
        .filter(
          (group) =>
            group !== removed &&
            group.api.isVisible &&
            (isLeftGroup(group) || isSessionGroup(group))
        )
        .map((group) => ({ group, width: group.api.width }))
    );
  });
  const groupRemoval = api.onDidRemoveGroup((removed) => {
    const targets = pending.get(removed);
    pending.delete(removed);
    if (
      !targets ||
      !api.groups.some((group) => isEditorGroup(group) && group.api.isVisible)
    )
      return;
    settleDockviewGroupWidths(
      targets.filter(({ group }) => api.groups.includes(group))
    );
  });
  const layoutRestoration = api.onDidLayoutFromJSON(() => {
    pending.clear();
    normalizeRestoredSlots();
  });
  return {
    oldestVisiblePanel() {
      for (const id of opened) {
        const panel = api.getPanel(id);
        if (
          panel &&
          isLeftShellNavGroup(panel.group) &&
          panel.group.api.isVisible &&
          panel.group.activePanel === panel
        )
          return panel;
      }
      return undefined;
    },
    dispose() {
      panelAddition.dispose();
      panelRemoval.dispose();
      groupRemoval.dispose();
      layoutRestoration.dispose();
      pending.clear();
    },
  };
}
