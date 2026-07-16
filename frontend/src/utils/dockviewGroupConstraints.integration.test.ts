import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { applyWorkspaceZoneConstraints } from './dockviewWorkspaceConstraints';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createApi(): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(1360, 800, true);
  return api;
}

describe('workspace zone constraints', () => {
  it('prevents a session group from being persisted below its usable width', () => {
    const api = createApi();
    const editor = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    const session = api.addGroup({
      id: 'group-right',
      referencePanel: editor,
      direction: 'right',
      constraints: { minimumWidth: 400 },
      initialWidth: 408,
    });
    api.addPanel({
      id: 'ai-chat',
      component: 'ai-chat',
      title: 'Sessions',
      position: { referenceGroup: session, direction: 'within' },
    });
    const serialized = api.toJSON();
    api.dispose();

    const restored = createApi();
    restored.fromJSON(serialized);
    applyWorkspaceZoneConstraints(restored);
    const restoredSession = restored.getGroup('group-right')!;

    restoredSession.api.setSize({ width: 120 });

    expect(Math.round(restoredSession.api.width)).toBe(400);
    restored.dispose();
  });
});
