import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  addSessionPanelWithoutStealingFocus,
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

  const session = api.addGroup({
    id: 'group-right',
    referencePanel: welcome,
    direction: 'right',
    hideHeader: true,
    initialWidth: 434,
  });

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
