import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import {
  applyLeftGroupHeaderHiding,
  assignDockviewGroupIdAndRole,
} from './dockviewHelpers';
import { getDockviewGroupRole } from './dockviewGroupRole';
import { normalizeGroupIds } from '@/components/layout/ideLayoutGroupNormalization';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function mockRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
  onRead?: () => void
) {
  element.getBoundingClientRect = () => {
    onRead?.();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function createMockGroup(options: {
  id: string;
  panelIds?: string[];
  visible?: boolean;
  rect?: { left: number; top: number; width: number; height: number };
  shellNavSide?: 'left' | 'right';
  onReadRect?: () => void;
  onWrite?: (op: string) => void;
}) {
  const element = document.createElement('div');
  if (options.shellNavSide) {
    element.setAttribute('data-shell-nav-side', options.shellNavSide);
  }
  if (options.rect) {
    mockRect(element, options.rect, options.onReadRect);
  }

  const origSetAttr = element.setAttribute.bind(element);
  const origRemoveAttr = element.removeAttribute.bind(element);
  const origAddClass = element.classList.add.bind(element.classList);
  const origRemoveClass = element.classList.remove.bind(element.classList);

  element.setAttribute = (name: string, value: string) => {
    options.onWrite?.(`setAttr:${name}=${value}`);
    origSetAttr(name, value);
  };
  element.removeAttribute = (name: string) => {
    options.onWrite?.(`removeAttr:${name}`);
    origRemoveAttr(name);
  };
  element.classList.add = (...tokens: string[]) => {
    options.onWrite?.(`addClass:${tokens.join(',')}`);
    origAddClass(...tokens);
  };
  element.classList.remove = (...tokens: string[]) => {
    options.onWrite?.(`removeClass:${tokens.join(',')}`);
    origRemoveClass(...tokens);
  };

  let hiddenState = false;
  let lockedState: boolean | string = false;

  return {
    id: options.id,
    panels: (options.panelIds ?? []).map((id) => ({ id })),
    element,
    get locked() {
      return lockedState;
    },
    set locked(val: boolean | string) {
      options.onWrite?.(`setGroupLocked:${String(val)}`);
      lockedState = val;
    },
    model: {
      get locked() {
        return lockedState;
      },
      set locked(val: boolean | string) {
        options.onWrite?.(`setModelLocked:${String(val)}`);
        lockedState = val;
      },
      header: {
        get hidden() {
          return hiddenState;
        },
        set hidden(val: boolean) {
          options.onWrite?.(`setHeaderHidden:${String(val)}`);
          hiddenState = val;
        },
      },
    },
    api: {
      isVisible: options.visible ?? true,
    },
  };
}

describe('applyLeftGroupHeaderHiding', () => {
  it('skips getBoundingClientRect entirely when there is 1 visible dock group and 1 visible stage group', () => {
    const readSpy = vi.fn();
    const leftGroup = createMockGroup({
      id: GROUP_IDS.LEFT,
      panelIds: [PANEL_IDS.FILE_TREE],
      rect: { left: 0, top: 0, width: 220, height: 800 },
      onReadRect: readSpy,
    });
    const editorGroup = createMockGroup({
      id: 'group-editor-1',
      panelIds: [PANEL_IDS.WELCOME],
      rect: { left: 220, top: 0, width: 980, height: 800 },
      onReadRect: readSpy,
    });

    const api = {
      groups: [leftGroup, editorGroup],
      getPanel: () => undefined,
    } as unknown as DockviewApi;

    applyLeftGroupHeaderHiding(api);

    expect(readSpy).not.toHaveBeenCalled();
    expect(leftGroup.element.classList.contains('dv-header-hidden')).toBe(true);
    expect(leftGroup.element.getAttribute('data-left-dock')).toBe('true');
    expect(editorGroup.element.getAttribute('data-stage-leftmost')).toBe(
      'true'
    );
    expect(editorGroup.element.getAttribute('data-stage-rightmost')).toBe(
      'true'
    );
    expect(editorGroup.element.getAttribute('data-stage-topmost')).toBe('true');
    expect(editorGroup.element.getAttribute('data-stage-bottommost')).toBe(
      'true'
    );
  });

  it('batches all getBoundingClientRect reads strictly before any DOM/model write and avoids redundant writes on repeat calls', () => {
    const opLog: string[] = [];

    const leftTop = createMockGroup({
      id: GROUP_IDS.LEFT,
      panelIds: [PANEL_IDS.FILE_TREE],
      rect: { left: 0, top: 0, width: 220, height: 400 },
      onReadRect: () => opLog.push('read:leftTop'),
      onWrite: (op) => opLog.push(`write:leftTop:${op}`),
    });
    const leftBottom = createMockGroup({
      id: 'group-left-1',
      panelIds: [PANEL_IDS.GIT],
      rect: { left: 0, top: 400, width: 220, height: 400 },
      onReadRect: () => opLog.push('read:leftBottom'),
      onWrite: (op) => opLog.push(`write:leftBottom:${op}`),
    });
    const editorGroup = createMockGroup({
      id: 'group-editor-1',
      panelIds: [PANEL_IDS.WELCOME],
      rect: { left: 220, top: 0, width: 580, height: 800 },
      onReadRect: () => opLog.push('read:editor'),
      onWrite: (op) => opLog.push(`write:editor:${op}`),
    });
    const sessionGroup = createMockGroup({
      id: GROUP_IDS.RIGHT,
      panelIds: [PANEL_IDS.AI_CHAT],
      rect: { left: 800, top: 0, width: 400, height: 800 },
      onReadRect: () => opLog.push('read:session'),
      onWrite: (op) => opLog.push(`write:session:${op}`),
    });

    const api = {
      groups: [leftTop, leftBottom, editorGroup, sessionGroup],
      getPanel: () => undefined,
    } as unknown as DockviewApi;

    applyLeftGroupHeaderHiding(api);

    const lastReadIndex = opLog.reduce(
      (acc, entry, idx) => (entry.startsWith('read:') ? idx : acc),
      -1
    );
    const firstWriteIndex = opLog.findIndex((entry) =>
      entry.startsWith('write:')
    );

    expect(lastReadIndex).toBeGreaterThanOrEqual(0);
    expect(firstWriteIndex).toBeGreaterThan(lastReadIndex);

    // Verify computed split and stage attributes
    expect(leftTop.element.getAttribute('data-left-dock-split-bottom')).toBe(
      'true'
    );
    expect(leftBottom.element.getAttribute('data-left-dock-split-top')).toBe(
      'true'
    );
    expect(editorGroup.element.getAttribute('data-stage-leftmost')).toBe(
      'true'
    );
    expect(editorGroup.element.getAttribute('data-stage-rightmost')).toBeNull();
    expect(sessionGroup.element.getAttribute('data-stage-rightmost')).toBe(
      'true'
    );
    expect(sessionGroup.element.getAttribute('data-stage-leftmost')).toBeNull();
    expect(sessionGroup.element.getAttribute('data-session-dock')).toBe('true');

    // Second invocation with identical geometry performs zero DOM/model writes!
    opLog.length = 0;
    applyLeftGroupHeaderHiding(api);
    const secondRunWrites = opLog.filter((entry) => entry.startsWith('write:'));
    expect(secondRunWrites).toEqual([]);
  });

  it('normalizes Dockview groups with WeakMap roles and synced registry entries', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const api = createDockview(container, {
      createComponent: () => ({
        element: document.createElement('div'),
        init: () => {},
        dispose: () => {},
      }),
    });
    api.layout(1400, 800, true);

    try {
      const welcome = api.addPanel({
        id: PANEL_IDS.WELCOME,
        component: PANEL_IDS.WELCOME,
        title: 'Welcome',
      });
      assignDockviewGroupIdAndRole(
        api,
        welcome.group,
        'group-editor-1',
        'editor'
      );

      const leftGroup = api.addGroup({
        id: GROUP_IDS.LEFT,
        direction: 'left',
        referencePanel: welcome,
      });
      api.addPanel({
        id: PANEL_IDS.FILE_TREE,
        component: PANEL_IDS.FILE_TREE,
        title: 'Files',
        position: { referenceGroup: leftGroup, direction: 'within' },
      });

      const rightGroup = api.addGroup({
        direction: 'right',
        referencePanel: welcome,
      });
      api.addPanel({
        id: PANEL_IDS.AI_CHAT,
        component: PANEL_IDS.AI_CHAT,
        title: 'Sessions',
        position: { referenceGroup: rightGroup, direction: 'within' },
      });

      normalizeGroupIds(api);

      expect(getDockviewGroupRole(welcome.group)).toBe('editor');
      expect(getDockviewGroupRole(leftGroup)).toBe('left');
      expect(getDockviewGroupRole(rightGroup)).toBe('session');
      expect(rightGroup.id).toBe(GROUP_IDS.RIGHT);
      expect(api.getGroup(GROUP_IDS.RIGHT)).toBe(rightGroup);
    } finally {
      api.dispose();
    }
  });
});
