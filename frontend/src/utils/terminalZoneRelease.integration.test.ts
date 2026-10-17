import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  isTerminalShelfOpen,
  resetTerminalShelfForTests,
  terminalShelfGroupId,
} from '@/lib/terminalShelf';
import { GROUP_IDS } from '@/stores/useLayoutStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { isEditorGroup } from './dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import { releaseLegacyTerminalZones } from './terminalZoneRelease';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

afterEach(() => {
  resetTerminalShelfForTests();
  useTerminalStore.setState({ sessionsByWorkspace: {} });
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
  api.layout(1200, 800, true);
  return api;
}

describe('releaseLegacyTerminalZones', () => {
  it('turns a hidden bottom strip into an editor group and keeps its sessions', () => {
    const api = createApi();
    const welcome = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    (welcome.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const bottom = api.addGroup({
      id: GROUP_IDS.BOTTOM,
      referencePanel: welcome,
      direction: 'below',
      locked: 'no-drop-target',
    });
    api.addPanel({
      id: 'terminal',
      component: 'terminal',
      title: 'Terminal',
      position: { referenceGroup: bottom, direction: 'within' },
      inactive: true,
    });
    bottom.element.classList.add('dv-header-hidden');
    bottom.api.setVisible(false);

    useTerminalStore.setState({
      sessionsByWorkspace: {
        'ws-release': [
          {
            tabId: 'term-existing',
            sessionId: 'pty-1',
            workspaceId: 'ws-release',
            title: 'PowerShell',
            shell: 'powershell.exe',
            surface: 'panel',
          },
        ],
      },
    });

    releaseLegacyTerminalZones(api);

    expect(api.getGroup(GROUP_IDS.BOTTOM)).toBeUndefined();
    expect(api.getPanel('terminal')).toBeUndefined();
    const shelf = api.getGroup(terminalShelfGroupId() ?? '');
    expect(shelf).toBeDefined();
    expect(isEditorGroup(shelf!)).toBe(true);
    expect(shelf!.locked).not.toBe('no-drop-target');
    const shelfElement = (shelf as unknown as { element: HTMLElement }).element;
    expect(shelfElement.classList.contains('dv-header-hidden')).toBe(false);
    expect(shelf!.panels.map((panel) => panel.id)).toEqual([
      'terminal:term-existing',
    ]);
    expect(shelf!.panels[0]?.params).toMatchObject({
      surface: 'editor',
      tabId: 'term-existing',
      shell: 'powershell.exe',
      terminalShelf: true,
    });
    expect(
      useTerminalStore.getState().sessionsByWorkspace['ws-release']?.[0]
        ?.surface
    ).toBe('editor');
    expect(isTerminalShelfOpen()).toBe(false);

    api.dispose();
  });
});
