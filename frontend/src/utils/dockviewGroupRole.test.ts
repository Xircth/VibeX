import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  assignDockviewGroupIdAndRole,
  getDockviewGroupRole,
  setDockviewGroupRole,
  syncDockviewGroupRegistry,
} from './dockviewGroupRole';
import {
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
} from './dockviewGroupPolicy';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createTestDockview(): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(1200, 800, true);
  return api;
}

describe('dockviewGroupRole', () => {
  it('stores and retrieves zone roles per group reference via WeakMap', () => {
    const g1 = { id: '1', panels: [] };
    const g2 = { id: '2', panels: [] };

    expect(getDockviewGroupRole(null)).toBeNull();
    expect(getDockviewGroupRole(undefined)).toBeNull();
    expect(getDockviewGroupRole(g1)).toBeNull();

    setDockviewGroupRole(g1, 'session');
    setDockviewGroupRole(g2, 'editor');

    expect(getDockviewGroupRole(g1)).toBe('session');
    expect(getDockviewGroupRole(g2)).toBe('editor');

    setDockviewGroupRole(g1, 'editor');
    expect(getDockviewGroupRole(g1)).toBe('editor');
  });

  it('atomically assigns group id, WeakMap role, and internal Dockview registry keys', () => {
    const api = createTestDockview();
    try {
      const welcome = api.addPanel({
        id: 'welcome',
        component: 'welcome',
        title: 'Welcome',
      });
      const autoCreatedGroup = welcome.group;

      assignDockviewGroupIdAndRole(
        api,
        autoCreatedGroup,
        'group-editor-1',
        'editor'
      );

      expect(autoCreatedGroup.id).toBe('group-editor-1');
      expect(getDockviewGroupRole(autoCreatedGroup)).toBe('editor');
      expect(api.getGroup('group-editor-1')).toBe(autoCreatedGroup);

      // Round-trip serialization/fromJSON clears groups via removeGroup(),
      // which throws if _groups was not atomically re-keyed.
      const snapshot = api.toJSON();
      expect(() => api.fromJSON(snapshot)).not.toThrow();
      expect(api.getGroup('group-editor-1')).toBeDefined();
    } finally {
      api.dispose();
    }
  });

  it('guards against duplicate group id collisions while still recording WeakMap role', () => {
    const api = createTestDockview();
    try {
      const firstPanel = api.addPanel({
        id: 'first',
        component: 'first',
        title: 'First',
      });
      assignDockviewGroupIdAndRole(
        api,
        firstPanel.group,
        'group-right',
        'session'
      );

      const secondGroup = api.addGroup({
        direction: 'right',
        referencePanel: firstPanel,
      });
      const originalSecondId = secondGroup.id;

      // Attempting to assign an already-taken group id must not corrupt the first group
      assignDockviewGroupIdAndRole(api, secondGroup, 'group-right', 'session');

      expect(secondGroup.id).toBe(originalSecondId);
      expect(api.getGroup('group-right')).toBe(firstPanel.group);
      expect(getDockviewGroupRole(secondGroup)).toBe('session');
      expect(isSessionGroup(secondGroup)).toBe(true);
      expect(isEditorGroup(secondGroup)).toBe(false);
    } finally {
      api.dispose();
    }
  });

  it('preserves zone role classification even if group.id is frozen or _groups is unavailable', () => {
    const frozenGroup = { id: 'auto-99', panels: [] as Array<{ id: string }> };
    Object.defineProperty(frozenGroup, 'id', {
      value: 'auto-99',
      writable: false,
      configurable: true,
    });

    const mockApi = {
      groups: [frozenGroup],
    } as unknown as DockviewApi;

    expect(() =>
      assignDockviewGroupIdAndRole(mockApi, frozenGroup, 'group-left', 'left')
    ).not.toThrow();

    expect(frozenGroup.id).toBe('auto-99');
    expect(getDockviewGroupRole(frozenGroup)).toBe('left');
    expect(isLeftGroup(frozenGroup)).toBe(true);
    expect(isEditorGroup(frozenGroup)).toBe(false);
    expect(isSessionGroup(frozenGroup)).toBe(false);
    expect(isBottomGroup(frozenGroup)).toBe(false);
  });

  it('hardens syncDockviewGroupRegistry against missing internals, cyclic grid nodes, and external canonical renames', () => {
    const g = {
      id: 'group-bottom',
      model: { id: 'old-model-id' },
      api: { id: 'old-api-id' },
      panels: [],
    };
    setDockviewGroupRole(g, 'bottom');

    // Simulate external canonical rename (e.g., terminalZoneRelease converting group-bottom -> group-editor-1)
    g.id = 'group-editor-1';

    const leafNode = { id: 'old-leaf-id', view: g };
    const branchNode: { children: unknown[] } = { children: [leafNode] };
    branchNode.children.push(branchNode); // cycle guard check

    const fakeApi = {
      groups: [g],
      component: {
        _groups: new Map([['group-bottom', { value: g }]]),
        gridview: { root: branchNode },
      },
    } as unknown as DockviewApi;

    expect(() => syncDockviewGroupRegistry(fakeApi)).not.toThrow();
    expect(g.model.id).toBe('group-editor-1');
    expect(g.api.id).toBe('group-editor-1');
    expect(leafNode.id).toBe('group-editor-1');
    expect(getDockviewGroupRole(g)).toBe('editor');

    // Missing component / malformed _groups must never throw
    expect(() =>
      syncDockviewGroupRegistry({ groups: [] } as unknown as DockviewApi)
    ).not.toThrow();
    expect(() =>
      syncDockviewGroupRegistry({
        groups: [],
        component: { _groups: null },
      } as unknown as DockviewApi)
    ).not.toThrow();
  });

  it('reconciles canonical DOM/ID attributes over stale WeakMap roles while keeping session tabs dropped into editor splits as editor groups', () => {
    const splitLeftGroup = {
      id: '14',
      panels: [{ id: 'file-tree' }],
      element: document.createElement('div'),
    };
    // Unassigned raw group infers 'left' from LEFT_PANEL_IDS
    expect(isLeftGroup(splitLeftGroup)).toBe(true);
    expect(isEditorGroup(splitLeftGroup)).toBe(false);

    // Even if previously stamped 'editor', setting data-left-dock="true" reconciles to 'left'
    setDockviewGroupRole(splitLeftGroup, 'editor');
    splitLeftGroup.element.setAttribute('data-left-dock', 'true');
    expect(isLeftGroup(splitLeftGroup)).toBe(true);
    expect(isEditorGroup(splitLeftGroup)).toBe(false);

    const editorSplitWithSessionTab = {
      id: '15',
      panels: [{ id: 'ai-chat:session-42' }],
      element: document.createElement('div'),
    };
    setDockviewGroupRole(editorSplitWithSessionTab, 'editor');

    expect(isEditorGroup(editorSplitWithSessionTab)).toBe(true);
    expect(isSessionGroup(editorSplitWithSessionTab)).toBe(false);
  });
});
