import type { DockviewApi } from 'dockview-core';
import {
  clearTerminalShelf,
  markTerminalShelf,
  terminalShelfGroupId,
} from '@/lib/terminalShelf';
import { editorTerminalPanelId } from '@/lib/workspaceTerminalTabs';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';
import type { TerminalPanelParams } from '@/types/panels';
import { showGroupHeader } from '@/utils/dockviewEditorSplit';
import {
  getNextEditorGroupId,
  isEditorGroup,
} from '@/utils/dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';

let releasing = false;

function panelParams(panel: { params?: unknown }): TerminalPanelParams {
  return (panel.params ?? {}) as TerminalPanelParams;
}

function adoptPanelSessions(tabIds: readonly string[]): void {
  if (tabIds.length === 0) return;
  const ids = new Set(tabIds);
  useTerminalStore.setState((state) => ({
    sessionsByWorkspace: Object.fromEntries(
      Object.entries(state.sessionsByWorkspace).map(
        ([workspaceId, sessions]) => [
          workspaceId,
          sessions.map((session) =>
            ids.has(session.tabId)
              ? { ...session, surface: 'editor' as const }
              : session
          ),
        ]
      )
    ),
  }));
}

function adoptLegacyTerminalGroup(
  api: DockviewApi,
  group: DockviewApi['groups'][number]
): void {
  const singleton = group.panels.find(
    (panel) => panel.id === PANEL_IDS.TERMINAL
  );
  const panelSessions = Object.values(
    useTerminalStore.getState().sessionsByWorkspace
  )
    .flat()
    .filter((session) => session.surface !== 'editor');

  if (singleton) {
    const sessions = panelSessions.length > 0 ? panelSessions : [null];
    for (const session of sessions) {
      const tabId = session?.tabId ?? generateTerminalTabId();
      const panelId = editorTerminalPanelId(tabId);
      if (api.getPanel(panelId)) continue;
      api.addPanel({
        id: panelId,
        component: PANEL_IDS.TERMINAL,
        title: session?.title || 'Terminal',
        renderer: 'onlyWhenVisible',
        params: {
          surface: 'editor',
          tabId,
          ...(session?.shell ? { shell: session.shell } : {}),
          terminalShelf: true,
        },
        position: { referenceGroup: group, direction: 'within' },
        inactive: !group.api.isVisible,
      });
    }
    adoptPanelSessions(panelSessions.map((session) => session.tabId));
    const current = api.getPanel(PANEL_IDS.TERMINAL);
    if (current) {
      api.removePanel(current);
    }
  }

  if (group.id === GROUP_IDS.BOTTOM) {
    const nextId = getNextEditorGroupId(api);
    (group as { id: string }).id = nextId;
    syncDockviewGroupRegistry(api);
  }

  group.locked = false;
  showGroupHeader(group);
  markTerminalShelf(group.id, group.api.isVisible);
}

/**
 * The retired bottom strip is a normal editor group. Running panel sessions
 * become tabs with the same id so their PTYs stay attached.
 */
export function releaseLegacyTerminalZones(api: DockviewApi): void {
  if (releasing) return;
  const targets = api.groups.filter(
    (group) =>
      group.id === GROUP_IDS.BOTTOM ||
      group.panels.some((panel) => panel.id === PANEL_IDS.TERMINAL)
  );
  if (targets.length === 0) return;

  releasing = true;
  try {
    for (const group of [...targets]) {
      if (!api.groups.includes(group)) continue;
      adoptLegacyTerminalGroup(api, group);
    }
  } finally {
    releasing = false;
  }
}

/** Restore shelf identity after a reload, without overriding a live toggle. */
export function rememberTerminalShelfFromApi(api: DockviewApi): void {
  const remembered = terminalShelfGroupId();
  if (remembered) {
    const existing = api.getGroup(remembered);
    if (!existing) clearTerminalShelf(remembered);
    return;
  }

  const candidates = api.groups.filter(
    (group) =>
      isEditorGroup(group) &&
      group.panels.some((panel) => panelParams(panel).terminalShelf === true)
  );
  const shelf = candidates[candidates.length - 1];
  if (!shelf) return;
  markTerminalShelf(shelf.id, shelf.api.isVisible);
}
