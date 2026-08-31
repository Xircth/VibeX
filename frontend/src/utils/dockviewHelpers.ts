import type { DockviewApi } from 'dockview-react';
import { ACTIVITY_RAIL_ITEMS } from '@/lib/activityRailOrder';

/**
 * Apply header hiding to the left group (file tree / git / search / sessions).
 *
 * Dockview's `hideHeader` is honored during `addGroup()` but may not
 * survive a `fromJSON()` layout restore.  This function finds the group
 * containing a left dock panel and hides its tab header via DOM,
 * acting as a reliable post-restore fallback.
 */
export function applyLeftGroupHeaderHiding(api: DockviewApi): void {
  type GroupWithHeaderModel = {
    model?: {
      header?: {
        hidden?: boolean;
      };
    };
  };

  const leftPanel = ACTIVITY_RAIL_ITEMS.map((panelId) =>
    api.getPanel(panelId)
  ).find(Boolean);

  if (!leftPanel) return;

  const group = leftPanel.group;
  if (!group) return;

  // Use the documented `hidden` setter on the group header model
  try {
    const model = (group as GroupWithHeaderModel).model;
    if (model?.header && typeof model.header.hidden !== 'undefined') {
      model.header.hidden = true;
    }
  } catch {
    // Fallback: add a CSS class to the group element
  }

  // CSS class fallback – always apply so the CSS rule can hide the header
  group.element?.classList.add('dv-header-hidden');
}

/**
 * Re-key dockview's internal group registry after group ids were renamed.
 *
 * The layout code re-assigns group ids (e.g. the auto-created welcome group
 * becomes `group-editor-1`), but dockview keeps its `_groups` map keyed by
 * the id used at creation time. A stale key makes `getGroup()` miss and —
 * critically — makes `fromJSON()` on a populated instance throw
 * `invalid operation` while clearing, because `removeGroup()` looks the
 * group up by its (renamed) id. Syncing the map keys keeps both paths safe.
 */
export function syncDockviewGroupRegistry(api: DockviewApi): void {
  const component = (
    api as unknown as {
      component?: { _groups?: Map<string, { value?: { id?: string } }> };
    }
  ).component;
  const registry = component?._groups;
  if (!registry) return;

  for (const [key, entry] of [...registry.entries()]) {
    const actualId = entry?.value?.id;
    if (
      typeof actualId === 'string' &&
      actualId !== key &&
      !registry.has(actualId)
    ) {
      registry.delete(key);
      registry.set(actualId, entry);
    }
  }
}
