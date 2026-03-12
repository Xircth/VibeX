import type { DockviewApi } from 'dockview-react';
import { PANEL_IDS } from '@/stores/useLayoutStore';

/**
 * Apply header hiding to the left group (file tree / git panel).
 *
 * Dockview's `hideHeader` is honored during `addGroup()` but may not
 * survive a `fromJSON()` layout restore.  This function finds the group
 * containing the file-tree or git panel and hides its tab header via DOM,
 * acting as a reliable post-restore fallback.
 */
export function applyLeftGroupHeaderHiding(api: DockviewApi): void {
  const leftPanel =
    api.getPanel(PANEL_IDS.FILE_TREE) ?? api.getPanel(PANEL_IDS.GIT);

  if (!leftPanel) return;

  const group = leftPanel.group;
  if (!group) return;

  // Use the documented `hidden` setter on the group header model
  try {
    const model = (group as any).model;
    if (model?.header && typeof model.header.hidden !== 'undefined') {
      model.header.hidden = true;
    }
  } catch {
    // Fallback: add a CSS class to the group element
  }

  // CSS class fallback – always apply so the CSS rule can hide the header
  group.element?.classList.add('dv-header-hidden');
}
