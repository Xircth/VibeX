import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  attachDockviewWorkspaceListeners,
  registerDockviewOverlayDropGuard,
  type DropTargetZone,
} from '@/components/layout/ideLayoutDockviewListeners';
import {
  closeEmptyTabBarGroups,
  ensureDockviewSessionPanel,
} from '@/components/layout/ideLayoutGroupNormalization';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { PANEL_IDS, useLayoutStore } from '@/stores/useLayoutStore';
import { setSessionDockVisible } from './dockviewEditorGroup';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import {
  addSessionPanelWithoutStealingFocus,
  getLiveDockviewApi,
  isDockviewApiDisposed,
  revealSessionPanelWithoutStealingFocus,
} from './dockviewSessionPanel';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createApi(width = 1600): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(width, 800, true);
  return api;
}

function buildWelcomeAndSessionGroup(api: DockviewApi) {
  const welcome = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
  });
  (welcome.group as { id: string }).id = 'group-editor-1';

  const session = api.addGroup({
    id: 'group-right',
    referencePanel: welcome,
    direction: 'right',
    hideHeader: true,
    initialWidth: 434,
  });
  syncDockviewGroupRegistry(api);

  return { welcome, session };
}

describe('revealSessionPanelWithoutStealingFocus', () => {
  it('shows a session panel that was added inactive without stealing editor focus', () => {
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);

    const panel = api.addPanel({
      id: PANEL_IDS.AI_CHAT,
      component: PANEL_IDS.AI_CHAT,
      title: 'Sessions',
      position: {
        referenceGroup: session,
        direction: 'within',
      },
      inactive: true,
    });

    expect(session.activePanel).toBeUndefined();
    expect(session.element.contains(panel.view.content.element)).toBe(false);

    welcome.api.setActive();
    revealSessionPanelWithoutStealingFocus(panel);

    expect(session.activePanel?.id).toBe(PANEL_IDS.AI_CHAT);
    expect(api.activePanel?.id).toBe(welcome.id);
    expect(session.element.contains(panel.view.content.element)).toBe(true);

    api.dispose();
  });

  it('keeps an already visible session panel mounted', () => {
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);

    const panel = api.addPanel({
      id: PANEL_IDS.AI_CHAT,
      component: PANEL_IDS.AI_CHAT,
      title: 'Sessions',
      position: {
        referenceGroup: session,
        direction: 'within',
      },
    });
    welcome.api.setActive();

    revealSessionPanelWithoutStealingFocus(panel);

    expect(session.activePanel?.id).toBe(PANEL_IDS.AI_CHAT);
    expect(api.activePanel?.id).toBe(welcome.id);
    expect(session.element.contains(panel.view.content.element)).toBe(true);

    api.dispose();
  });

  it('does not throw "invalid location" when called on a disposed Dockview instance', () => {
    const api = createApi();
    const { session } = buildWelcomeAndSessionGroup(api);
    const panel = addSessionPanelWithoutStealingFocus(api, session);

    expect(isDockviewApiDisposed(api)).toBe(false);
    expect(getLiveDockviewApi(api)).toBe(api);

    api.dispose();

    expect(isDockviewApiDisposed(api)).toBe(true);
    expect(getLiveDockviewApi(api)).toBeNull();
    // Raw Dockview leaves `model.panels` populated after emptying `_tabs` on
    // dispose, causing direct `openPanel` to throw `Error("invalid location")`.
    expect(() =>
      panel.group.model.openPanel(panel, { skipSetGroupActive: true })
    ).toThrow('invalid location');

    expect(() => revealSessionPanelWithoutStealingFocus(panel)).not.toThrow();
    expect(() => ensureDockviewSessionPanel(api)).not.toThrow();
    expect(ensureDockviewSessionPanel(api)).toBeUndefined();
  });
});

describe('addSessionPanelWithoutStealingFocus', () => {
  it('creates the missing session panel and mounts it without stealing editor focus', () => {
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    welcome.api.setActive();

    const panel = addSessionPanelWithoutStealingFocus(api, session);

    expect(panel.id).toBe(PANEL_IDS.AI_CHAT);
    expect(session.activePanel?.id).toBe(PANEL_IDS.AI_CHAT);
    expect(api.activePanel?.id).toBe(welcome.id);
    expect(session.element.contains(panel.view.content.element)).toBe(true);

    api.dispose();
  });
});

describe('empty tab bar prevention', () => {
  it('populates group-right with Sessions instead of leaving an empty group when session tabs live in Zone B', () => {
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    session.api.setVisible(false);
    api.addPanel({
      id: `${PANEL_IDS.AI_CHAT}:master`,
      component: PANEL_IDS.AI_CHAT,
      title: 'Master',
      position: { referenceGroup: welcome.group, direction: 'within' },
    });

    const ensured = ensureDockviewSessionPanel(api);
    expect(ensured).toBe(session);
    expect(session.panels.map((p) => p.id)).toEqual([PANEL_IDS.AI_CHAT]);

    setSessionDockVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, true);
    expect(
      api.groups.filter((g) => g.api.isVisible && g.panels.length === 0)
    ).toHaveLength(0);

    api.dispose();
  });

  it('never shows an empty session group when setSessionDockVisible(..., true) is called or ai-chat is already in Zone B', () => {
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    session.api.setVisible(false);

    setSessionDockVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, true);
    expect(session.api.isVisible).toBe(false);

    api.addPanel({
      id: PANEL_IDS.AI_CHAT,
      component: PANEL_IDS.AI_CHAT,
      title: 'Sessions',
      position: { referenceGroup: welcome.group, direction: 'within' },
    });

    const ensured = ensureDockviewSessionPanel(api);
    expect(ensured).toBeUndefined();
    expect(session.panels).toHaveLength(0);
    expect(session.api.isVisible).toBe(false);

    api.dispose();
  });

  it('closes Zone C when its last session tab is closed while another session tab exists in Zone B', () => {
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setRightPanelVisible(true);
    const api = createApi();
    const lastDropTargetZoneRef: { current: DropTargetZone } = {
      current: null,
    };
    const cleanup = attachDockviewWorkspaceListeners(api, {
      apiRef: { current: api },
      dockviewRootEl: null,
      isResettingRef: { current: false },
      isCollapsedRef: { current: false },
      lastDropTargetZoneRef,
      layoutChangeTimerRef: { current: null },
      lastSelfHealAtRef: { current: 0 },
      registerDndGuard: (dockApi) =>
        registerDockviewOverlayDropGuard(dockApi, lastDropTargetZoneRef),
      applyArrangement: vi.fn(),
      setSerializedLayout: vi.fn(),
      setRightPanelWidth: vi.fn(),
    });

    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    api.addPanel({
      id: `${PANEL_IDS.AI_CHAT}:master`,
      component: PANEL_IDS.AI_CHAT,
      title: 'Master',
      position: { referenceGroup: welcome.group, direction: 'within' },
    });
    const rightSessionPanel = api.addPanel({
      id: `${PANEL_IDS.AI_CHAT}:side`,
      component: PANEL_IDS.AI_CHAT,
      title: 'Side Session',
      position: { referenceGroup: session, direction: 'within' },
    });

    api.removePanel(rightSessionPanel);

    expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    expect(session.api.isVisible).toBe(false);
    expect(
      api.groups.filter((g) => g.api.isVisible && g.panels.length === 0)
    ).toHaveLength(0);

    cleanup();
    api.dispose();
  });

  it('closes Zone C instead of recreating a visible empty group when dragging its last tab into Zone B', () => {
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setRightPanelVisible(true);
    const api = createApi();
    const lastDropTargetZoneRef: { current: DropTargetZone } = {
      current: null,
    };
    const cleanup = attachDockviewWorkspaceListeners(api, {
      apiRef: { current: api },
      dockviewRootEl: null,
      isResettingRef: { current: false },
      isCollapsedRef: { current: false },
      lastDropTargetZoneRef,
      layoutChangeTimerRef: { current: null },
      lastSelfHealAtRef: { current: 0 },
      registerDndGuard: (dockApi) =>
        registerDockviewOverlayDropGuard(dockApi, lastDropTargetZoneRef),
      applyArrangement: vi.fn(),
      setSerializedLayout: vi.fn(),
      setRightPanelWidth: vi.fn(),
    });

    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    const rightSessionPanel = api.addPanel({
      id: `${PANEL_IDS.AI_CHAT}:side`,
      component: PANEL_IDS.AI_CHAT,
      title: 'Side Session',
      position: { referenceGroup: session, direction: 'within' },
    });

    const host = (
      api as unknown as {
        component: {
          moveGroupOrPanel: (options: {
            from: { groupId: string; panelId: string };
            to: { group: typeof welcome.group; position: 'center' };
          }) => void;
        };
      }
    ).component;
    host.moveGroupOrPanel({
      from: { groupId: session.id, panelId: rightSessionPanel.id },
      to: { group: welcome.group, position: 'center' },
    });

    expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    expect(rightSessionPanel.group).toBe(welcome.group);
    expect(
      api.groups.filter((g) => g.api.isVisible && g.panels.length === 0)
    ).toHaveLength(0);

    cleanup();
    api.dispose();
  });

  it('removes redundant empty split groups via closeEmptyTabBarGroups', () => {
    useLayoutStore.getState().resetLayout();
    useLayoutStore.getState().setRightPanelVisible(true);
    const api = createApi();
    const { welcome, session } = buildWelcomeAndSessionGroup(api);
    const extraEmptyEditor = api.addGroup({
      id: 'group-editor-2',
      referencePanel: welcome,
      direction: 'right',
    });
    syncDockviewGroupRegistry(api);
    expect(extraEmptyEditor.panels).toHaveLength(0);
    expect(extraEmptyEditor.api.isVisible).toBe(true);

    closeEmptyTabBarGroups(api);

    expect(api.getGroup('group-editor-2')).toBeUndefined();
    expect(session.api.isVisible).toBe(false);
    expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    expect(
      api.groups.filter((g) => g.api.isVisible && g.panels.length === 0)
    ).toHaveLength(0);

    api.dispose();
  });
});
