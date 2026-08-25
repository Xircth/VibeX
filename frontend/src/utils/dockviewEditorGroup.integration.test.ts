import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import {
  CRUSHED_EDITOR_COLUMN_WIDTH,
  ensureWelcomeEditorGroup,
  isEditorColumnCrushed,
  shouldPersistSessionColumnWidth,
} from './dockviewEditorGroup';
import {
  defaultSessionPanelWidth,
  settleDockviewGroupWidths,
} from './dockviewStartupSizing';

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

function buildWorkspace(
  api: DockviewApi,
  options?: { hideTerminal?: boolean }
) {
  const welcome = api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
  });
  (welcome.group as { id: string }).id = 'group-editor-1';
  syncDockviewGroupRegistry(api);

  const fileTree = api.addGroup({
    id: 'group-left',
    referencePanel: welcome,
    direction: 'left',
    constraints: { minimumWidth: 200 },
    initialWidth: 200,
  });
  api.addPanel({
    id: 'file-tree',
    component: 'file-tree',
    title: 'Files',
    position: { referenceGroup: fileTree, direction: 'within' },
  });

  const session = api.addGroup({
    id: 'group-right',
    referencePanel: welcome,
    direction: 'right',
    constraints: { minimumWidth: 400 },
    initialWidth: defaultSessionPanelWidth(api.width, 400),
  });
  api.addPanel({
    id: 'ai-chat',
    component: 'ai-chat',
    title: 'Sessions',
    position: { referenceGroup: session, direction: 'within' },
  });

  const terminal = api.addGroup({
    id: 'group-bottom',
    referencePanel: welcome,
    direction: 'below',
    locked: 'no-drop-target',
    initialHeight: 200,
  });
  api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'Terminal',
    position: { referenceGroup: terminal, direction: 'within' },
    inactive: true,
  });
  if (options?.hideTerminal !== false) {
    terminal.api.setVisible(false);
  }

  settleDockviewGroupWidths([
    { group: fileTree, width: 200 },
    { group: session, width: 434 },
  ]);

  return { welcome, fileTree, session, terminal };
}

function editorGroup(api: DockviewApi) {
  return (
    api.groups.find((group) => group.id === 'group-editor-1') ??
    api.getPanel('welcome')?.group ??
    api.getPanel('file:README.md')?.group
  );
}

describe('ensureWelcomeEditorGroup', () => {
  it('restores a usable editor column after the last tab is closed', () => {
    const api = createApi();
    const { welcome, session } = buildWorkspace(api);
    const sessionWidthBeforeClose = Math.round(session.api.width);
    const editorWidthBeforeClose = Math.round(welcome.group.api.width);

    expect(editorWidthBeforeClose).toBeGreaterThan(CRUSHED_EDITOR_COLUMN_WIDTH);

    api.removePanel(welcome);

    const restored = ensureWelcomeEditorGroup(api, {
      arrangement: DEFAULT_LAYOUT_ARRANGEMENT,
      sessionWidth: sessionWidthBeforeClose,
    });

    expect(restored).toBeDefined();
    expect(Math.round(restored!.api.width)).toBeGreaterThan(
      CRUSHED_EDITOR_COLUMN_WIDTH
    );
    expect(Math.round(restored!.api.width)).toBeGreaterThan(400);
    expect(Math.round(session.api.width)).toBeLessThan(editorWidthBeforeClose);
    expect(isEditorColumnCrushed(api)).toBe(false);
    api.dispose();
  });

  it('keeps the restored width when a file tab replaces the welcome panel', () => {
    const api = createApi();
    const { welcome, session } = buildWorkspace(api);
    const sessionWidthBeforeClose = Math.round(session.api.width);

    api.removePanel(welcome);
    const restored = ensureWelcomeEditorGroup(api, {
      arrangement: DEFAULT_LAYOUT_ARRANGEMENT,
      sessionWidth: sessionWidthBeforeClose,
    });
    const widthAfterRestore = Math.round(restored!.api.width);

    const filePanel = api.addPanel({
      id: 'file:README.md',
      component: 'preview',
      title: 'README.md',
      position: { referenceGroup: restored!.id, direction: 'within' },
    });
    const welcomeAfter = api.getPanel('welcome');
    if (welcomeAfter) {
      api.removePanel(welcomeAfter);
    }

    expect(Math.round(filePanel.group.api.width)).toBeGreaterThan(
      CRUSHED_EDITOR_COLUMN_WIDTH
    );
    expect(Math.round(filePanel.group.api.width)).toBeGreaterThanOrEqual(
      widthAfterRestore - 8
    );
    api.dispose();
  });

  it('does not persist the expanded session width while the editor is crushed', () => {
    const api = createApi();
    const { welcome } = buildWorkspace(api);
    api.removePanel(welcome);

    expect(shouldPersistSessionColumnWidth(api)).toBe(false);

    ensureWelcomeEditorGroup(api, {
      arrangement: DEFAULT_LAYOUT_ARRANGEMENT,
      sessionWidth: 434,
    });

    expect(shouldPersistSessionColumnWidth(api)).toBe(true);
    api.dispose();
  });

  it('heals an already-crushed editor group on the next ensure', () => {
    const api = createApi();
    const { welcome, session } = buildWorkspace(api);
    api.removePanel(welcome);

    const crushed = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
      position: {
        referencePanel: api.getPanel('terminal')!,
        direction: 'above',
      },
      inactive: true,
    });
    (crushed.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    expect(Math.round(crushed.group.api.width)).toBeLessThanOrEqual(
      CRUSHED_EDITOR_COLUMN_WIDTH
    );
    expect(isEditorColumnCrushed(api)).toBe(true);

    ensureWelcomeEditorGroup(api, {
      arrangement: DEFAULT_LAYOUT_ARRANGEMENT,
      sessionWidth: 434,
    });

    expect(Math.round(editorGroup(api)!.api.width)).toBeGreaterThan(400);
    expect(Math.round(session.api.width)).toBeLessThan(700);
    api.dispose();
  });
});
