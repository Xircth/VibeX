import type { DockviewApi } from 'dockview-react';
import { ACTIVITY_RAIL_ITEMS } from '@/lib/activityRailOrder';
import {
  isBottomGroup,
  isLeftGroup,
  isSessionGroup,
  listLeftDockGroups,
} from '@/utils/dockviewGroupPolicy';
export {
  assignDockviewGroupIdAndRole,
  syncDockviewGroupRegistry,
} from '@/utils/dockviewGroupRole';

type DockviewGroup = DockviewApi['groups'][number];

interface GroupWithHeaderModel {
  locked?: boolean | string;
  model?: {
    locked?: boolean | string;
    header?: {
      hidden?: boolean;
    };
  };
}

function setOrRemoveAttr(
  el: HTMLElement | undefined,
  attr: string,
  enabled: boolean
): void {
  if (!el || el.hasAttribute(attr) === enabled) return;
  if (enabled) {
    el.setAttribute(attr, 'true');
  } else {
    el.removeAttribute(attr);
  }
}

function setOrRemoveClass(
  el: HTMLElement | undefined,
  className: string,
  enabled: boolean
): void {
  if (!el || el.classList.contains(className) === enabled) return;
  if (enabled) {
    el.classList.add(className);
  } else {
    el.classList.remove(className);
  }
}

/**
 * Apply header hiding to the left group (file tree / git / search / sessions),
 * while ensuring workspace (Zone B) and session dock (Zone C) groups remain
 * unlocked and show their multi-tab header bars.
 *
 * Structured in two strict phases (pure DOM reads -> minimal-diff DOM writes)
 * so geometry measurements never interleave with style/attribute writes.
 */
export function applyLeftGroupHeaderHiding(api: DockviewApi): void {
  // --- Phase 1: Pure Reads (before any DOM/model writes) ---
  const leftGroups = new Set<DockviewGroup>([
    ...listLeftDockGroups(api.groups),
    ...ACTIVITY_RAIL_ITEMS.map(
      (panelId) => api.getPanel(panelId)?.group
    ).filter((group): group is DockviewGroup =>
      Boolean(group && isLeftGroup(group))
    ),
  ]);

  const bottomGroups = new Set<DockviewGroup>();
  const sessionGroups = new Set<DockviewGroup>();
  const stageGroups: DockviewGroup[] = [];

  for (const group of api.groups) {
    if (leftGroups.has(group)) continue;
    if (isBottomGroup(group)) {
      bottomGroups.add(group);
    } else if (isSessionGroup(group)) {
      sessionGroups.add(group);
    }
    if (group.api.isVisible && Boolean(group.element)) {
      stageGroups.push(group);
    }
  }

  const visibleDockGroupsBySide: Record<'left' | 'right', DockviewGroup[]> = {
    left: [],
    right: [],
  };
  for (const group of leftGroups) {
    if (!group.api.isVisible || !group.element) continue;
    const groupSide =
      group.element.getAttribute('data-shell-nav-side') === 'right'
        ? 'right'
        : 'left';
    visibleDockGroupsBySide[groupSide].push(group);
  }

  const groupsToMeasure = new Set<DockviewGroup>();
  if (visibleDockGroupsBySide.left.length > 1) {
    for (const group of visibleDockGroupsBySide.left) {
      groupsToMeasure.add(group);
    }
  }
  if (visibleDockGroupsBySide.right.length > 1) {
    for (const group of visibleDockGroupsBySide.right) {
      groupsToMeasure.add(group);
    }
  }
  if (stageGroups.length > 1) {
    for (const group of stageGroups) {
      groupsToMeasure.add(group);
    }
  }

  const measuredRects = new Map<DockviewGroup, DOMRect>();
  for (const group of groupsToMeasure) {
    const rect = group.element?.getBoundingClientRect();
    if (rect) {
      measuredRects.set(group, rect);
    }
  }

  const dockSplitLeft = new Set<DockviewGroup>();
  const dockSplitTop = new Set<DockviewGroup>();
  const dockSplitBottom = new Set<DockviewGroup>();

  for (const side of ['left', 'right'] as const) {
    const visibleDockGroups = visibleDockGroupsBySide[side];
    if (visibleDockGroups.length <= 1) continue;

    const dockRects = visibleDockGroups.flatMap((group) => {
      const rect = measuredRects.get(group);
      return rect && rect.width > 0 && rect.height > 0 ? [{ group, rect }] : [];
    });

    if (dockRects.length > 1) {
      const minLeft = Math.min(...dockRects.map((item) => item.rect.left));
      const minTop = Math.min(...dockRects.map((item) => item.rect.top));
      const maxBottom = Math.max(...dockRects.map((item) => item.rect.bottom));
      for (const { group, rect } of dockRects) {
        if (rect.left > minLeft + 4) {
          dockSplitLeft.add(group);
        }
        if (rect.top > minTop + 4) {
          dockSplitTop.add(group);
        }
        if (rect.bottom < maxBottom - 4) {
          dockSplitBottom.add(group);
        }
      }
    } else {
      for (const group of visibleDockGroups.slice(1)) {
        const parentSplit = group.element?.closest('.dv-split-view-container');
        if (parentSplit?.classList.contains('dv-vertical')) {
          dockSplitTop.add(group);
        } else {
          dockSplitLeft.add(group);
        }
      }
    }
  }

  const stageLeftmost = new Set<DockviewGroup>();
  const stageRightmost = new Set<DockviewGroup>();
  const stageTopmost = new Set<DockviewGroup>();
  const stageBottommost = new Set<DockviewGroup>();

  if (stageGroups.length === 1) {
    const onlyGroup = stageGroups[0];
    if (onlyGroup) {
      stageLeftmost.add(onlyGroup);
      stageRightmost.add(onlyGroup);
      stageTopmost.add(onlyGroup);
      stageBottommost.add(onlyGroup);
    }
  } else if (stageGroups.length > 1) {
    const rects = stageGroups.flatMap((group) => {
      const rect = measuredRects.get(group);
      return rect && rect.width > 0 && rect.height > 0 ? [{ group, rect }] : [];
    });

    if (rects.length > 0) {
      const minLeft = Math.min(...rects.map((item) => item.rect.left));
      const maxRight = Math.max(...rects.map((item) => item.rect.right));
      const minTop = Math.min(...rects.map((item) => item.rect.top));
      const maxBottom = Math.max(...rects.map((item) => item.rect.bottom));
      for (const { group, rect } of rects) {
        if (Math.abs(rect.left - minLeft) <= 2) {
          stageLeftmost.add(group);
        }
        if (Math.abs(rect.right - maxRight) <= 2) {
          stageRightmost.add(group);
        }
        if (Math.abs(rect.top - minTop) <= 2) {
          stageTopmost.add(group);
        }
        if (Math.abs(rect.bottom - maxBottom) <= 2) {
          stageBottommost.add(group);
        }
      }
    } else {
      const bottomStageGroups = stageGroups.filter((group) =>
        bottomGroups.has(group)
      );
      const upperStageGroups = stageGroups.filter(
        (group) => !bottomGroups.has(group)
      );
      if (upperStageGroups.length > 0) {
        const leftmostUpper = upperStageGroups[0];
        const rightmostUpper = upperStageGroups[upperStageGroups.length - 1];
        if (leftmostUpper) {
          stageLeftmost.add(leftmostUpper);
        }
        if (rightmostUpper) {
          stageRightmost.add(rightmostUpper);
        }
        for (const group of upperStageGroups) {
          stageTopmost.add(group);
          if (bottomStageGroups.length === 0) {
            stageBottommost.add(group);
          }
        }
      }
      for (const group of bottomStageGroups) {
        stageLeftmost.add(group);
        stageRightmost.add(group);
        stageBottommost.add(group);
        if (upperStageGroups.length === 0) {
          stageTopmost.add(group);
        }
      }
    }
  }

  // --- Phase 2: Pure Writes (minimal-diff, zero geometry reads) ---
  for (const group of leftGroups) {
    try {
      const model = (group as GroupWithHeaderModel).model;
      if (
        model?.header &&
        typeof model.header.hidden !== 'undefined' &&
        model.header.hidden !== true
      ) {
        model.header.hidden = true;
      }
    } catch {
      // Fallback: CSS class below still hides the header.
    }

    setOrRemoveClass(group.element, 'dv-header-hidden', true);
    setOrRemoveAttr(group.element, 'data-left-dock', true);
  }

  for (const group of api.groups) {
    if (!leftGroups.has(group) && !bottomGroups.has(group)) {
      try {
        const mutable = group as GroupWithHeaderModel;
        if (mutable.locked !== false) {
          mutable.locked = false;
        }
        if (
          mutable.model &&
          typeof mutable.model.locked !== 'undefined' &&
          mutable.model.locked !== false
        ) {
          mutable.model.locked = false;
        }
        if (
          mutable.model?.header &&
          typeof mutable.model.header.hidden !== 'undefined' &&
          mutable.model.header.hidden !== false
        ) {
          mutable.model.header.hidden = false;
        }
      } catch {
        // Ignore model access errors.
      }

      setOrRemoveClass(group.element, 'dv-header-hidden', false);
      setOrRemoveClass(group.element, 'dv-locked-groupview', false);
      if (sessionGroups.has(group)) {
        setOrRemoveAttr(group.element, 'data-session-dock', true);
      }
    }

    const el = group.element;
    setOrRemoveAttr(el, 'data-stage-leftmost', stageLeftmost.has(group));
    setOrRemoveAttr(el, 'data-stage-rightmost', stageRightmost.has(group));
    setOrRemoveAttr(el, 'data-stage-topmost', stageTopmost.has(group));
    setOrRemoveAttr(el, 'data-stage-bottommost', stageBottommost.has(group));
    setOrRemoveAttr(el, 'data-left-dock-split-left', dockSplitLeft.has(group));
    setOrRemoveAttr(el, 'data-left-dock-split-top', dockSplitTop.has(group));
    setOrRemoveAttr(
      el,
      'data-left-dock-split-bottom',
      dockSplitBottom.has(group)
    );
  }
}
