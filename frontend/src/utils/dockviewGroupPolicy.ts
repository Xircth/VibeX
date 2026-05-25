import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  PANEL_IDS,
} from '@/stores/useLayoutStore';

export const LEFT_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
]);

export const BOTTOM_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.TERMINAL,
]);

export const PLACEHOLDER_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.WELCOME,
]);

interface DockviewGroupLike {
  id: string;
  panels: Array<{ id: string }>;
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

export function isLeftGroup(group: DockviewGroupLike): boolean {
  return (
    group.id === GROUP_IDS.LEFT ||
    group.panels.some((panel) => LEFT_PANEL_IDS.has(panel.id))
  );
}

export function isBottomGroup(group: DockviewGroupLike): boolean {
  return (
    group.id === GROUP_IDS.BOTTOM ||
    group.panels.some((panel) => BOTTOM_PANEL_IDS.has(panel.id))
  );
}

export function isEditorGroup(group: DockviewGroupLike): boolean {
  return !isLeftGroup(group) && !isBottomGroup(group);
}

export function isSplittableEditorPanel(panel: DockviewPanelLike): boolean {
  return isEditorGroup(panel.group) && !isPlaceholderPanelId(panel.id);
}

export function getGroupElement(group: DockviewGroupLike): HTMLElement | null {
  const value = group as unknown as { element?: HTMLElement };
  return value.element ?? null;
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

export function getNextEditorGroupId(dockviewApi: DockviewApiLike): string {
  const existing = new Set(dockviewApi.groups.map((group) => group.id));
  let index = 1;

  while (existing.has(`${EDITOR_GROUP_PREFIX}${index}`)) {
    index += 1;
  }

  return `${EDITOR_GROUP_PREFIX}${index}`;
}
