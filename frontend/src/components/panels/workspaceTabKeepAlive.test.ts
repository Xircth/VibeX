import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_WARM_HIDDEN_PANELS,
  getDockviewPanelKeepAliveState,
  registerDockviewPanelKeepAlive,
  resetDockviewPanelKeepAliveStore,
  unregisterDockviewPanelKeepAlive,
  updateDockviewPanelKeepAlive,
  useDockviewPanelKeepAlive,
  type KeepAliveDockviewPanelApi,
} from './workspaceTabKeepAlive';

interface MockPanelController {
  api: KeepAliveDockviewPanelApi;
  setVisible: (isVisible: boolean) => void;
  setActive: (isActive: boolean) => void;
  visibilityDisposableCount: () => number;
  activeDisposableCount: () => number;
}

function createMockPanelApi(
  id: string,
  initialVisible = true
): MockPanelController {
  let visible = initialVisible;
  const visibilityListeners = new Set<
    (event: { isVisible: boolean }) => void
  >();
  const activeListeners = new Set<(event: { isActive: boolean }) => void>();

  const api: KeepAliveDockviewPanelApi = {
    id,
    get isVisible() {
      return visible;
    },
    onDidVisibilityChange: (listener) => {
      visibilityListeners.add(listener);
      return {
        dispose: () => {
          visibilityListeners.delete(listener);
        },
      };
    },
    onDidActiveChange: (listener) => {
      activeListeners.add(listener);
      return {
        dispose: () => {
          activeListeners.delete(listener);
        },
      };
    },
  };

  return {
    api,
    setVisible(nextVisible: boolean) {
      visible = nextVisible;
      for (const listener of visibilityListeners) {
        listener({ isVisible: nextVisible });
      }
    },
    setActive(isActive: boolean) {
      for (const listener of activeListeners) {
        listener({ isActive });
      }
    },
    visibilityDisposableCount: () => visibilityListeners.size,
    activeDisposableCount: () => activeListeners.size,
  };
}

describe('workspaceTabKeepAlive', () => {
  beforeEach(() => {
    resetDockviewPanelKeepAliveStore();
  });

  afterEach(() => {
    cleanup();
    resetDockviewPanelKeepAliveStore();
  });

  it('defaults to DEFAULT_MAX_WARM_HIDDEN_PANELS = 5 and keeps the 5 most recently visible hidden panels warm', () => {
    expect(DEFAULT_MAX_WARM_HIDDEN_PANELS).toBe(5);

    const scope = 'session-tab';
    // Open tabs 1..7 sequentially so tabs 1..6 become hidden in order 1..6 and tab 7 stays visible.
    for (let index = 1; index <= 7; index += 1) {
      if (index > 1) {
        updateDockviewPanelKeepAlive(`tab-${index - 1}`, {
          scope,
          isVisible: false,
        });
      }
      registerDockviewPanelKeepAlive(`tab-${index}`, {
        scope,
        isVisible: true,
      });
    }

    // Tab 7 is visible -> always mounted.
    expect(getDockviewPanelKeepAliveState('tab-7', { scope })).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });

    // Tabs 2..6 are the 5 most recently visible hidden panels -> warm & mounted.
    for (const id of ['tab-2', 'tab-3', 'tab-4', 'tab-5', 'tab-6']) {
      expect(getDockviewPanelKeepAliveState(id, { scope })).toEqual({
        isVisible: false,
        shouldKeepMounted: true,
      });
    }

    // Tab 1 is hidden rank 6 -> hibernated.
    expect(getDockviewPanelKeepAliveState('tab-1', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });
  });

  it('promotes a revisited tab in LRU order and evicts the oldest remaining hidden tab', () => {
    const scope = 'session-tab';
    for (let index = 1; index <= 7; index += 1) {
      if (index > 1) {
        updateDockviewPanelKeepAlive(`tab-${index - 1}`, {
          scope,
          isVisible: false,
        });
      }
      registerDockviewPanelKeepAlive(`tab-${index}`, {
        scope,
        isVisible: true,
      });
    }

    // Revisit hibernated tab-1 while tab-7 hides.
    updateDockviewPanelKeepAlive('tab-7', { scope, isVisible: false });
    updateDockviewPanelKeepAlive('tab-1', { scope, isVisible: true });

    expect(getDockviewPanelKeepAliveState('tab-1', { scope })).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });
    // Hidden tabs are now tab-7, tab-6, tab-5, tab-4, tab-3 (warm) and tab-2 (oldest -> hibernated).
    for (const id of ['tab-3', 'tab-4', 'tab-5', 'tab-6', 'tab-7']) {
      expect(getDockviewPanelKeepAliveState(id, { scope })).toEqual({
        isVisible: false,
        shouldKeepMounted: true,
      });
    }
    expect(getDockviewPanelKeepAliveState('tab-2', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });
  });

  it('never evicts visible split-column panels and does not count them against the hidden warm budget', () => {
    const scope = 'session-tab';

    // Two side-by-side visible columns: col-a and col-b.
    registerDockviewPanelKeepAlive('col-a', { scope, isVisible: true });
    registerDockviewPanelKeepAlive('col-b', { scope, isVisible: true });

    // Plus 6 hidden tabs where hidden-1 is oldest and hidden-2..hidden-6 are the 5 most recent.
    for (let index = 1; index <= 6; index += 1) {
      registerDockviewPanelKeepAlive(`hidden-${index}`, {
        scope,
        isVisible: true,
      });
      updateDockviewPanelKeepAlive(`hidden-${index}`, {
        scope,
        isVisible: false,
      });
    }

    expect(getDockviewPanelKeepAliveState('col-a', { scope })).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });
    expect(getDockviewPanelKeepAliveState('col-b', { scope })).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });
    for (const id of [
      'hidden-2',
      'hidden-3',
      'hidden-4',
      'hidden-5',
      'hidden-6',
    ]) {
      expect(getDockviewPanelKeepAliveState(id, { scope })).toEqual({
        isVisible: false,
        shouldKeepMounted: true,
      });
    }
    expect(getDockviewPanelKeepAliveState('hidden-1', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });

    // When long-lived visible col-a finally hides, it becomes the MOST recently visible hidden tab.
    updateDockviewPanelKeepAlive('col-a', { scope, isVisible: false });
    expect(getDockviewPanelKeepAliveState('col-a', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: true,
    });
    expect(getDockviewPanelKeepAliveState('hidden-2', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });
  });

  it('always keeps pinned panels mounted without consuming unpinned warm hidden slots', () => {
    const scope = 'session-tab';
    registerDockviewPanelKeepAlive('pinned-oldest', {
      scope,
      isVisible: false,
      pinned: true,
    });

    for (let index = 1; index <= 6; index += 1) {
      registerDockviewPanelKeepAlive(`unpinned-${index}`, {
        scope,
        isVisible: false,
      });
    }

    expect(getDockviewPanelKeepAliveState('pinned-oldest', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: true,
    });
    // 5 most recent unpinned hidden tabs remain warm even with pinned-oldest hidden.
    for (const id of [
      'unpinned-2',
      'unpinned-3',
      'unpinned-4',
      'unpinned-5',
      'unpinned-6',
    ]) {
      expect(getDockviewPanelKeepAliveState(id, { scope })).toEqual({
        isVisible: false,
        shouldKeepMounted: true,
      });
    }
    expect(getDockviewPanelKeepAliveState('unpinned-1', { scope })).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });
  });

  it('isolates LRU budgets across scopes and frees slots when tabs close', () => {
    for (let index = 1; index <= 6; index += 1) {
      registerDockviewPanelKeepAlive(`s-${index}`, {
        scope: 'session-tab',
        isVisible: false,
      });
    }
    registerDockviewPanelKeepAlive('other-1', {
      scope: 'editor-tab',
      isVisible: false,
      maxWarmHidden: 1,
    });

    expect(
      getDockviewPanelKeepAliveState('s-1', { scope: 'session-tab' })
        .shouldKeepMounted
    ).toBe(false);
    expect(
      getDockviewPanelKeepAliveState('other-1', { scope: 'editor-tab' })
        .shouldKeepMounted
    ).toBe(true);

    // Closing s-6 frees a warm slot in session-tab.
    unregisterDockviewPanelKeepAlive('s-6', 'session-tab');
    expect(
      getDockviewPanelKeepAliveState('s-1', { scope: 'session-tab' })
        .shouldKeepMounted
    ).toBe(true);
  });

  it('wakes up a hibernated panel on the exact render visibility becomes true and cleans up on unmount', () => {
    const controllers = Array.from({ length: 7 }, (_, index) =>
      createMockPanelApi(`panel-${index + 1}`, index === 6)
    );

    const rendered = controllers.map((controller) => {
      const states: Array<{ isVisible: boolean; shouldKeepMounted: boolean }> =
        [];
      const hook = renderHook(() => {
        const state = useDockviewPanelKeepAlive(controller.api, {
          scope: 'session-tab',
          maxWarmHidden: 5,
        });
        states.push(state);
        return state;
      });
      return { controller, hook, states };
    });

    // panel-1 is oldest hidden (rank 6) -> hibernated.
    expect(rendered[0].hook.result.current).toEqual({
      isVisible: false,
      shouldKeepMounted: false,
    });

    const renderCountBeforeWake = rendered[0].states.length;

    // Clicking panel-1 fires visibility true; on that very next render BOTH flags are true.
    act(() => {
      rendered[6].controller.setVisible(false);
      rendered[0].controller.setVisible(true);
    });

    const wakeRenders = rendered[0].states.slice(renderCountBeforeWake);
    expect(wakeRenders.length).toBeGreaterThanOrEqual(1);
    expect(wakeRenders[0]).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });
    expect(
      wakeRenders.some((entry) => entry.isVisible && !entry.shouldKeepMounted)
    ).toBe(false);

    // Unmounting disposes listeners and unregisters from the store.
    rendered[6].hook.unmount();
    expect(rendered[6].controller.visibilityDisposableCount()).toBe(0);
    expect(rendered[6].controller.activeDisposableCount()).toBe(0);
  });

  it('defaults to visible and mounted when api or api.isVisible is undefined in lightweight mocks', () => {
    const { result: noApi } = renderHook(() =>
      useDockviewPanelKeepAlive(undefined, { scope: 'session-tab' })
    );
    expect(noApi.current).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });

    const minimalApi: KeepAliveDockviewPanelApi = {
      id: 'minimal-mock',
      onDidVisibilityChange: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const { result: partialApi } = renderHook(() =>
      useDockviewPanelKeepAlive(minimalApi, { scope: 'session-tab' })
    );
    expect(partialApi.current).toEqual({
      isVisible: true,
      shouldKeepMounted: true,
    });
  });
});
