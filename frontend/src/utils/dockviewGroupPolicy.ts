import { ACTIVITY_RAIL_ITEMS } from '@/lib/activityRailOrder';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  PANEL_IDS,
} from '@/stores/useLayoutStore';

export const LEFT_PANEL_IDS: ReadonlySet<string> = new Set(ACTIVITY_RAIL_ITEMS);

export const BOTTOM_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.TERMINAL,
]);

export const SESSION_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.AI_CHAT,
]);

export const SESSION_PANEL_PREFIX = `${PANEL_IDS.AI_CHAT}:`;

export function sessionPanelId(sessionId: string): string {
  return `${SESSION_PANEL_PREFIX}${sessionId}`;
}

export function isSessionPanelId(panelId: string): boolean {
  return (
    SESSION_PANEL_IDS.has(panelId) || panelId.startsWith(SESSION_PANEL_PREFIX)
  );
}

export const PLACEHOLDER_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.WELCOME,
]);

interface DockviewGroupLike {
  id: string;
  panels: ReadonlyArray<{ id: string }>;
  element?: HTMLElement;
}

interface DockviewPanelLike {
  id: string;
  group: DockviewGroupLike;
}

interface DockviewApiLike {
  groups: Array<{ id: string }>;
}

export function isPlaceholderPanelId(panelId: string): boolean {
  return PLACEHOLDER_PANEL_IDS.has(panelId);
}

export const LEFT_GROUP_PREFIX = `${GROUP_IDS.LEFT}-`;
export const RIGHT_GROUP_PREFIX = `${GROUP_IDS.RIGHT}-`;

export function isLeftGroup(group: DockviewGroupLike): boolean {
  if (
    group.id === GROUP_IDS.LEFT ||
    group.id.startsWith(LEFT_GROUP_PREFIX) ||
    group.element?.getAttribute('data-left-dock') === 'true'
  ) {
    return true;
  }
  if (
    group.id.startsWith(EDITOR_GROUP_PREFIX) ||
    group.id === GROUP_IDS.RIGHT ||
    group.id.startsWith(RIGHT_GROUP_PREFIX) ||
    group.id === GROUP_IDS.BOTTOM ||
    group.element?.getAttribute('data-session-dock') === 'true'
  ) {
    return false;
  }
  return group.panels.some((panel) => LEFT_PANEL_IDS.has(panel.id));
}

export function listLeftDockGroups<T extends DockviewGroupLike>(
  groups: readonly T[]
): T[] {
  return groups.filter((group) => isLeftGroup(group));
}

export function isRightShellNavGroup(group: DockviewGroupLike): boolean {
  return (
    isLeftGroup(group) &&
    group.element?.getAttribute('data-shell-nav-side') === 'right'
  );
}

export function isLeftShellNavGroup(group: DockviewGroupLike): boolean {
  return isLeftGroup(group) && !isRightShellNavGroup(group);
}

export function listLeftShellNavGroups<T extends DockviewGroupLike>(
  groups: readonly T[]
): T[] {
  return groups.filter((group) => isLeftShellNavGroup(group));
}

export function listRightShellNavGroups<T extends DockviewGroupLike>(
  groups: readonly T[]
): T[] {
  return groups.filter((group) => isRightShellNavGroup(group));
}

export function isBottomGroup(group: DockviewGroupLike): boolean {
  // Identity is the group id only. A terminal tab inside an editor group must
  // stay an editor group, or every split that holds a terminal is re-locked
  // into the retired bottom strip.
  return group.id === GROUP_IDS.BOTTOM;
}

export function isSessionGroup(group: DockviewGroupLike): boolean {
  if (
    group.id === GROUP_IDS.RIGHT ||
    group.id.startsWith(RIGHT_GROUP_PREFIX) ||
    group.element?.getAttribute('data-session-dock') === 'true'
  ) {
    return true;
  }
  if (
    group.id.startsWith(EDITOR_GROUP_PREFIX) ||
    group.id === GROUP_IDS.LEFT ||
    group.id.startsWith(LEFT_GROUP_PREFIX) ||
    group.id === GROUP_IDS.BOTTOM ||
    group.element?.getAttribute('data-left-dock') === 'true'
  ) {
    return false;
  }
  return group.panels.some((panel) => isSessionPanelId(panel.id));
}

export function listSessionGroups<T extends DockviewGroupLike>(
  groups: readonly T[]
): T[] {
  return groups.filter((group) => isSessionGroup(group));
}

export function isEditorGroup(group: DockviewGroupLike): boolean {
  return !isLeftGroup(group) && !isBottomGroup(group) && !isSessionGroup(group);
}

export function isSplittableEditorPanel(panel: DockviewPanelLike): boolean {
  return (
    (isEditorGroup(panel.group) ||
      isLeftGroup(panel.group) ||
      isSessionGroup(panel.group)) &&
    !isPlaceholderPanelId(panel.id)
  );
}

export function getGroupElement(group: DockviewGroupLike): HTMLElement | null {
  return group.element ?? null;
}

export function compareEditorGroups(
  a: DockviewGroupLike,
  b: DockviewGroupLike
): number {
  const aRect = getGroupElement(a)?.getBoundingClientRect();
  const bRect = getGroupElement(b)?.getBoundingClientRect();

  if (aRect && bRect) {
    if (Math.abs(aRect.left - bRect.left) > 1) {
      return aRect.left - bRect.left;
    }

    if (Math.abs(aRect.top - bRect.top) > 1) {
      return aRect.top - bRect.top;
    }
  }

  return a.id.localeCompare(b.id);
}

export function getNextLeftGroupId(dockviewApi: DockviewApiLike): string {
  const existing = new Set(dockviewApi.groups.map((group) => group.id));
  if (!existing.has(GROUP_IDS.LEFT)) {
    return GROUP_IDS.LEFT;
  }

  let index = 1;
  while (existing.has(`${LEFT_GROUP_PREFIX}${index}`)) {
    index += 1;
  }

  return `${LEFT_GROUP_PREFIX}${index}`;
}

export function getNextRightGroupId(dockviewApi: DockviewApiLike): string {
  const existing = new Set(dockviewApi.groups.map((group) => group.id));
  if (!existing.has(GROUP_IDS.RIGHT)) {
    return GROUP_IDS.RIGHT;
  }

  let index = 1;
  while (existing.has(`${RIGHT_GROUP_PREFIX}${index}`)) {
    index += 1;
  }

  return `${RIGHT_GROUP_PREFIX}${index}`;
}

export function getNextEditorGroupId(dockviewApi: DockviewApiLike): string {
  const existing = new Set(dockviewApi.groups.map((group) => group.id));
  let index = 1;

  while (existing.has(`${EDITOR_GROUP_PREFIX}${index}`)) {
    index += 1;
  }

  return `${EDITOR_GROUP_PREFIX}${index}`;
}
