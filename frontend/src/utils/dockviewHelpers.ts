import type { DockviewApi } from 'dockview-react';
import { ACTIVITY_RAIL_ITEMS } from '@/lib/activityRailOrder';
import {
  isBottomGroup,
  isLeftGroup,
  isSessionGroup,
  listLeftDockGroups,
} from '@/utils/dockviewGroupPolicy';

/**
 * Apply header hiding to the left group (file tree / git / search / sessions),
 * while ensuring workspace (Zone B) and session dock (Zone C) groups remain
 * unlocked and show their multi-tab header bars.
 */
export function applyLeftGroupHeaderHiding(api: DockviewApi): void {
  type GroupWithHeaderModel = {
    locked?: boolean | string;
    model?: {
      locked?: boolean | string;
      header?: {
        hidden?: boolean;
      };
    };
  };

  const leftGroups = new Set([
    ...listLeftDockGroups(api.groups),
    ...ACTIVITY_RAIL_ITEMS.map(
      (panelId) => api.getPanel(panelId)?.group
    ).filter((group): group is NonNullable<(typeof api.groups)[number]> =>
      Boolean(group && isLeftGroup(group))
    ),
  ]);

  for (const group of leftGroups) {
    try {
      const model = (group as GroupWithHeaderModel).model;
      if (model?.header && typeof model.header.hidden !== 'undefined') {
        model.header.hidden = true;
      }
    } catch {
      // Fallback: add a CSS class to the group element
    }

    group.element?.classList.add('dv-header-hidden');
    group.element?.setAttribute('data-left-dock', 'true');
  }

  for (const group of api.groups) {
    if (leftGroups.has(group) || isBottomGroup(group)) {
      continue;
    }

    try {
      const mutable = group as GroupWithHeaderModel;
      mutable.locked = false;
      if (mutable.model && typeof mutable.model.locked !== 'undefined') {
        mutable.model.locked = false;
      }
      if (
        mutable.model?.header &&
        typeof mutable.model.header.hidden !== 'undefined'
      ) {
        mutable.model.header.hidden = false;
      }
    } catch {
      // Ignore model access errors
    }

    group.element?.classList.remove('dv-header-hidden', 'dv-locked-groupview');
    if (isSessionGroup(group)) {
      group.element?.setAttribute('data-session-dock', 'true');
    }
  }

  const stageGroups = api.groups.filter(
    (group) =>
      !leftGroups.has(group) &&
      !isBottomGroup(group) &&
      group.api.isVisible &&
      Boolean(group.element)
  );

  for (const group of api.groups) {
    group.element?.removeAttribute('data-stage-leftmost');
    group.element?.removeAttribute('data-stage-rightmost');
  }

  if (stageGroups.length === 1) {
    stageGroups[0]?.element?.setAttribute('data-stage-leftmost', 'true');
    stageGroups[0]?.element?.setAttribute('data-stage-rightmost', 'true');
    return;
  }

  if (stageGroups.length > 1) {
    const rects = stageGroups.flatMap((group) => {
      const rect = group.element?.getBoundingClientRect();
      return rect && rect.width > 0 ? [{ group, rect }] : [];
    });

    if (rects.length > 0) {
      const minLeft = Math.min(...rects.map((item) => item.rect.left));
      const maxRight = Math.max(...rects.map((item) => item.rect.right));
      for (const { group, rect } of rects) {
        if (Math.abs(rect.left - minLeft) <= 2) {
          group.element?.setAttribute('data-stage-leftmost', 'true');
        }
        if (Math.abs(rect.right - maxRight) <= 2) {
          group.element?.setAttribute('data-stage-rightmost', 'true');
        }
      }
    } else {
      stageGroups[0]?.element?.setAttribute('data-stage-leftmost', 'true');
      stageGroups[stageGroups.length - 1]?.element?.setAttribute(
        'data-stage-rightmost',
        'true'
      );
    }
  }
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
      component?: {
        _groups?: Map<
          string,
          {
            value?: {
              id?: string;
              model?: { id?: string };
              api?: { id?: string };
            };
          }
        >;
      };
    }
  ).component;
  const registry = component?._groups;
  if (!registry) return;

  for (const [key, entry] of [...registry.entries()]) {
    const actualId = entry?.value?.id;
    if (typeof actualId === 'string') {
      if (entry.value?.model && typeof entry.value.model.id === 'string') {
        entry.value.model.id = actualId;
      }
      if (entry.value?.api && typeof entry.value.api.id === 'string') {
        (entry.value.api as { id: string }).id = actualId;
      }
    }
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
