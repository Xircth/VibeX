import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  createDockview,
  Orientation,
  type DockviewApi,
  type SerializedDockview,
} from 'dockview-core';
import { GLOBAL_PROJECT_SCOPE } from '@/lib/projectScope';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import {
  useLayoutStore,
  PANEL_IDS,
  GROUP_IDS,
  EDITOR_GROUP_PREFIX,
  MAX_EDITOR_GROUPS,
  migratePersistedLayoutState,
  sanitizeSerializedDockview,
  dropRetiredWebPreviewPanels,
} from './useLayoutStore';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
});

const mountedContainers: HTMLElement[] = [];
const activeApis: DockviewApi[] = [];

function createTestDockview(): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  mountedContainers.push(container);

  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(1280, 800, true);
  activeApis.push(api);
  return api;
}

function buildLiveWorkspaceLayout(api: DockviewApi): DockviewApi {
  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
  });
  (welcomePanel.group as unknown as { id: string }).id =
    `${EDITOR_GROUP_PREFIX}1`;

  const leftGroup = api.addGroup({
    id: GROUP_IDS.LEFT,
    referencePanel: welcomePanel,
    direction: 'left',
    hideHeader: true,
    initialWidth: 220,
  });
  api.addPanel({
    id: PANEL_IDS.FILE_TREE,
    component: PANEL_IDS.FILE_TREE,
    title: 'Files',
    position: { referenceGroup: leftGroup, direction: 'within' },
  });

  const rightGroup = api.addGroup({
    id: GROUP_IDS.RIGHT,
    referencePanel: welcomePanel,
    direction: 'right',
    hideHeader: true,
    initialWidth: 480,
  });
  api.addPanel({
    id: PANEL_IDS.AI_CHAT,
    component: PANEL_IDS.AI_CHAT,
    title: 'Sessions',
    position: { referenceGroup: rightGroup, direction: 'within' },
    inactive: true,
  });

  const bottomGroup = api.addGroup({
    id: GROUP_IDS.BOTTOM,
    referencePanel: welcomePanel,
    direction: 'below',
    initialHeight: 200,
  });
  api.addPanel({
    id: PANEL_IDS.TERMINAL,
    component: PANEL_IDS.TERMINAL,
    title: 'Terminal',
    position: { referenceGroup: bottomGroup, direction: 'within' },
    inactive: true,
  });

  syncDockviewGroupRegistry(
    api as unknown as Parameters<typeof syncDockviewGroupRegistry>[0]
  );
  return api;
}

afterEach(() => {
  while (activeApis.length > 0) {
    activeApis.pop()?.dispose();
  }
  while (mountedContainers.length > 0) {
    mountedContainers.pop()?.remove();
  }
});

describe('useLayoutStore', () => {
  beforeEach(() => {
    localStorage.removeItem('vibex-ide-layout');
    useLayoutStore.getState().setCurrentProject(GLOBAL_PROJECT_SCOPE);
    useLayoutStore.getState().resetLayout();
  });

  describe('initial state', () => {
    it('should have file tree visible by default', () => {
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(true);
    });

    it('should have right panel hidden by default under Unified A/B Zone layout', () => {
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    });

    it('should have every kanban zone visible by default', () => {
      const state = useLayoutStore.getState();
      expect(state.isKanbanListVisible).toBe(true);
      expect(state.isKanbanMonitorVisible).toBe(true);
      expect(state.isKanbanSessionVisible).toBe(true);
    });

    it('should have the 30%-smaller default right panel width', () => {
      expect(useLayoutStore.getState().rightPanelWidth).toBe(434);
    });

    it('should have workspace as active tab by default', () => {
      expect(useLayoutStore.getState().activeTab).toBe('workspace');
    });

    it('should have null serialized layout by default', () => {
      expect(useLayoutStore.getState().serializedLayout).toBeNull();
    });
  });

  describe('toggleFileTree', () => {
    it('should toggle file tree visibility', () => {
      const store = useLayoutStore.getState();
      expect(store.isFileTreeVisible).toBe(true);

      store.toggleFileTree();
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(false);

      store.toggleFileTree();
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(true);
    });
  });

  describe('setFileTreeVisible', () => {
    it('should set file tree visibility directly', () => {
      useLayoutStore.getState().setFileTreeVisible(false);
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(false);

      useLayoutStore.getState().setFileTreeVisible(true);
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(true);
    });
  });

  describe('setRightPanelWidth', () => {
    it('should set right panel width', () => {
      useLayoutStore.getState().setRightPanelWidth(600);
      expect(useLayoutStore.getState().rightPanelWidth).toBe(600);
    });

    it('should clamp width to minimum 400', () => {
      useLayoutStore.getState().setRightPanelWidth(200);
      expect(useLayoutStore.getState().rightPanelWidth).toBe(400);
    });

    it('should clamp width to maximum 900', () => {
      useLayoutStore.getState().setRightPanelWidth(1500);
      expect(useLayoutStore.getState().rightPanelWidth).toBe(900);
    });
  });

  describe('toggleRightPanel', () => {
    it('should toggle right panel visibility', () => {
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);

      useLayoutStore.getState().toggleRightPanel();
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(true);

      useLayoutStore.getState().toggleRightPanel();
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    });
  });

  describe('kanban zone visibility', () => {
    it('toggles each kanban zone independently', () => {
      const store = useLayoutStore.getState();

      store.toggleKanbanList();
      store.toggleKanbanMonitor();
      store.setKanbanSessionVisible(false);

      expect(useLayoutStore.getState().isKanbanListVisible).toBe(false);
      expect(useLayoutStore.getState().isKanbanMonitorVisible).toBe(false);
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(false);

      store.resetKanbanLayout();

      expect(useLayoutStore.getState().isKanbanListVisible).toBe(true);
      expect(useLayoutStore.getState().isKanbanMonitorVisible).toBe(true);
      expect(useLayoutStore.getState().isKanbanSessionVisible).toBe(true);
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);
    });
  });

  describe('setActiveTab', () => {
    it('should set active tab to workspace', () => {
      useLayoutStore.getState().setActiveTab('workspace');
      expect(useLayoutStore.getState().activeTab).toBe('workspace');
    });

    it('should set active tab to kanban', () => {
      useLayoutStore.getState().setActiveTab('workspace');
      useLayoutStore.getState().setActiveTab('kanban');
      expect(useLayoutStore.getState().activeTab).toBe('kanban');
    });
  });

  describe('resetLayout', () => {
    it('should reset all layout state to defaults', () => {
      const store = useLayoutStore.getState();
      store.setFileTreeVisible(false);
      store.setRightPanelWidth(600);
      store.setRightPanelVisible(true);
      store.setActiveTab('workspace');

      store.resetLayout();

      const reset = useLayoutStore.getState();
      expect(reset.isFileTreeVisible).toBe(true);
      expect(reset.rightPanelWidth).toBe(434);
      expect(reset.isRightPanelVisible).toBe(false);
      expect(reset.activeTab).toBe('workspace');
      expect(reset.serializedLayout).toBeNull();
    });
  });

  describe('idempotency and persistence churn prevention', () => {
    it('skips subscriber notifications and localStorage writes when setSerializedLayout receives an equivalent snapshot', () => {
      const api = buildLiveWorkspaceLayout(createTestDockview());
      const initialSnapshot = api.toJSON();

      useLayoutStore.getState().setSerializedLayout(initialSnapshot);

      let emissions = 0;
      const unsubscribe = useLayoutStore.subscribe(() => {
        emissions += 1;
      });
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

      try {
        // Freshly serialized clone from Dockview with identical structure
        useLayoutStore.getState().setSerializedLayout(api.toJSON());

        // Reordered keys and explicit `undefined` optional property
        const reorderedEquivalent = {
          panels: Object.fromEntries(
            Object.entries(initialSnapshot.panels).reverse()
          ),
          activeGroup: initialSnapshot.activeGroup,
          floatingGroups: undefined,
          grid: initialSnapshot.grid,
        } as unknown as SerializedDockview;
        useLayoutStore.getState().setSerializedLayout(reorderedEquivalent);

        // Snapshot carrying an unreferenced orphan panel that sanitizes to the same layout
        const withOrphanPanel = structuredClone(initialSnapshot);
        withOrphanPanel.panels['preview:orphan.ts'] = {
          id: 'preview:orphan.ts',
          contentComponent: 'preview',
          title: 'orphan.ts',
        } as SerializedDockview['panels'][string];
        useLayoutStore.getState().setSerializedLayout(withOrphanPanel);

        expect(emissions).toBe(0);
        expect(setItemSpy).not.toHaveBeenCalled();
      } finally {
        setItemSpy.mockRestore();
        unsubscribe();
      }
    });

    it('short-circuits redundant width, visibility, tab, and project setters before persistence', () => {
      const store = useLayoutStore.getState();
      store.setRightPanelWidth(400);
      store.setRightPanelVisible(false);
      store.setEditorAreaVisible(true);
      store.setFileTreeVisible(true);
      store.setActiveTab('workspace');

      let emissions = 0;
      const unsubscribe = useLayoutStore.subscribe(() => {
        emissions += 1;
      });
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

      try {
        // 200 clamps to 400, matching current width
        store.setRightPanelWidth(200);
        store.setRightPanelWidth(400);
        store.setRightPanelVisible(false);
        store.setEditorAreaVisible(true);
        store.setFileTreeVisible(true);
        store.setActiveTab('workspace');
        store.setCurrentProject(GLOBAL_PROJECT_SCOPE);
        store.resetKanbanLayout();

        expect(emissions).toBe(0);
        expect(setItemSpy).not.toHaveBeenCalled();
      } finally {
        setItemSpy.mockRestore();
        unsubscribe();
      }
    });
  });
});

describe('constants', () => {
  it('should export correct PANEL_IDS', () => {
    expect(PANEL_IDS.KANBAN).toBe('kanban');
    expect(PANEL_IDS.FILE_TREE).toBe('file-tree');
    expect(PANEL_IDS.TERMINAL).toBe('terminal');
    expect(PANEL_IDS.DIFFS).toBe('diffs');
    expect(PANEL_IDS.PREVIEW).toBe('preview');
  });

  it('should export correct GROUP_IDS', () => {
    expect(GROUP_IDS.LEFT).toBe('group-left');
    expect(GROUP_IDS.BOTTOM).toBe('group-bottom');
  });

  it('should export editor group settings', () => {
    expect(EDITOR_GROUP_PREFIX).toBe('group-editor-');
    expect(MAX_EDITOR_GROUPS).toBe(4);
  });
});

describe('sanitizeSerializedDockview against dockview-core fromJSON', () => {
  it('removes retired web-preview and dev-preview panels from both panels and leaf views when active', () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'preview:src/App.tsx',
      component: PANEL_IDS.PREVIEW,
      title: 'App.tsx',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    const retiredWebPreview = sourceApi.addPanel({
      id: 'web-preview',
      component: 'web-preview',
      title: 'Web Preview',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    retiredWebPreview.api.setActive();

    const raw = sourceApi.toJSON();
    const sanitized = dropRetiredWebPreviewPanels(raw);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.panels['web-preview']).toBeUndefined();

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(sanitized!)).not.toThrow();
    expect(targetApi.getPanel('web-preview')).toBeUndefined();
    expect(targetApi.getPanel('preview:src/App.tsx')).toBeDefined();
    expect(targetApi.getPanel(PANEL_IDS.WELCOME)).toBeDefined();
    expect(targetApi.getGroup(`${EDITOR_GROUP_PREFIX}1`)?.activePanel?.id).toBe(
      PANEL_IDS.WELCOME
    );
    expect(sanitizeSerializedDockview(sanitized)).toEqual(sanitized);
  });

  it('prunes a split editor group whose sole view was dev-preview:1 without collapsing remaining tabs', () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'preview:src/main.ts',
      component: PANEL_IDS.PREVIEW,
      title: 'main.ts',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    const splitGroup = sourceApi.addGroup({
      id: `${EDITOR_GROUP_PREFIX}2`,
      referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
      direction: 'right',
      initialWidth: 300,
    });
    const devPreviewPanel = sourceApi.addPanel({
      id: 'dev-preview:1',
      component: 'dev-preview',
      title: 'Dev Server',
      position: { referenceGroup: splitGroup, direction: 'within' },
    });
    devPreviewPanel.api.setActive();
    syncDockviewGroupRegistry(
      sourceApi as unknown as Parameters<typeof syncDockviewGroupRegistry>[0]
    );

    const raw = sourceApi.toJSON();
    expect(raw.activeGroup).toBe(`${EDITOR_GROUP_PREFIX}2`);

    const sanitized = sanitizeSerializedDockview(raw);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.panels['dev-preview:1']).toBeUndefined();
    expect(sanitized?.activeGroup).not.toBe(`${EDITOR_GROUP_PREFIX}2`);

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(sanitized!)).not.toThrow();
    expect(targetApi.getGroup(`${EDITOR_GROUP_PREFIX}2`)).toBeUndefined();
    expect(targetApi.getGroup(`${EDITOR_GROUP_PREFIX}1`)).toBeDefined();
    expect(targetApi.getPanel('preview:src/main.ts')).toBeDefined();
    expect(targetApi.getPanel(PANEL_IDS.WELCOME)).toBeDefined();
  });

  it('heals already-corrupted snapshots with dangling view IDs, duplicate views, orphan panels, and invalid maximized locations', () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'web-preview:stale',
      component: 'web-preview',
      title: 'Stale Web Preview',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });

    // Simulate the historical bug: panels['web-preview:stale'] was deleted,
    // leaving 'web-preview:stale' and another missing panel ID inside leaf.views.
    const corrupted = sourceApi.toJSON();
    delete corrupted.panels['web-preview:stale'];
    corrupted.panels['preview:leaked-orphan.ts'] = {
      id: 'preview:leaked-orphan.ts',
      contentComponent: 'preview',
      title: 'leaked-orphan.ts',
    } as SerializedDockview['panels'][string];

    const rootData = (
      corrupted.grid.root as unknown as {
        data: Array<{
          type: string;
          data: unknown;
        }>;
      }
    ).data;
    const centerBranch = rootData.find((node) => node.type === 'branch') as {
      data: Array<{
        data: { id: string; views: string[]; activeView?: string };
      }>;
    };
    const editorLeaf = centerBranch.data[0];
    editorLeaf.data.views.push('missing-dangling-panel', PANEL_IDS.WELCOME);
    editorLeaf.data.activeView = 'missing-dangling-panel';
    (
      corrupted.grid as unknown as { maximizedNode?: { location: number[] } }
    ).maximizedNode = { location: [99, 99] };

    const crashProbeApi = createTestDockview();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      expect(() => crashProbeApi.fromJSON(corrupted)).toThrow();
    } finally {
      consoleErrorSpy.mockRestore();
    }

    const sanitized = sanitizeSerializedDockview(corrupted);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.panels['preview:leaked-orphan.ts']).toBeUndefined();
    expect(
      (sanitized?.grid as unknown as { maximizedNode?: unknown }).maximizedNode
    ).toBeUndefined();

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(sanitized!)).not.toThrow();
    expect(
      targetApi
        .getGroup(`${EDITOR_GROUP_PREFIX}1`)
        ?.panels.map((panel) => panel.id)
    ).toEqual([PANEL_IDS.WELCOME]);
  });

  it('preserves Dockview orientation parity when collapsing a nested branch into its grandparent', () => {
    const nestedLayout = {
      grid: {
        width: 1280,
        height: 800,
        orientation: Orientation.HORIZONTAL,
        root: {
          type: 'branch',
          size: 800,
          data: [
            {
              type: 'leaf',
              size: 220,
              data: {
                id: GROUP_IDS.LEFT,
                views: [PANEL_IDS.FILE_TREE],
                activeView: PANEL_IDS.FILE_TREE,
              },
            },
            {
              // Depth 1: VERTICAL branch
              type: 'branch',
              size: 1060,
              data: [
                {
                  // Depth 2: HORIZONTAL split of two editor groups
                  type: 'branch',
                  size: 600,
                  data: [
                    {
                      type: 'leaf',
                      size: 530,
                      data: {
                        id: `${EDITOR_GROUP_PREFIX}1`,
                        views: [PANEL_IDS.WELCOME],
                        activeView: PANEL_IDS.WELCOME,
                      },
                    },
                    {
                      type: 'leaf',
                      size: 530,
                      data: {
                        id: `${EDITOR_GROUP_PREFIX}2`,
                        views: ['preview:a.ts'],
                        activeView: 'preview:a.ts',
                      },
                    },
                  ],
                },
                {
                  // Secondary workspace leaf whose sole retired panel gets pruned
                  type: 'leaf',
                  size: 200,
                  data: {
                    id: `${EDITOR_GROUP_PREFIX}3`,
                    views: ['web-preview'],
                    activeView: 'web-preview',
                  },
                },
              ],
            },
          ],
        },
      },
      panels: {
        [PANEL_IDS.FILE_TREE]: {
          id: PANEL_IDS.FILE_TREE,
          contentComponent: PANEL_IDS.FILE_TREE,
          title: 'Files',
        },
        [PANEL_IDS.WELCOME]: {
          id: PANEL_IDS.WELCOME,
          contentComponent: PANEL_IDS.WELCOME,
          title: 'Welcome',
        },
        'preview:a.ts': {
          id: 'preview:a.ts',
          contentComponent: PANEL_IDS.PREVIEW,
          title: 'a.ts',
        },
        'web-preview': {
          id: 'web-preview',
          contentComponent: 'web-preview',
          title: 'Web Preview',
        },
      },
      activeGroup: `${EDITOR_GROUP_PREFIX}3`,
    } as unknown as SerializedDockview;

    const sanitized = sanitizeSerializedDockview(nestedLayout);
    expect(sanitized).not.toBeNull();

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(sanitized!)).not.toThrow();
    expect(targetApi.groups.map((group) => group.id)).toEqual([
      GROUP_IDS.LEFT,
      `${EDITOR_GROUP_PREFIX}1`,
      `${EDITOR_GROUP_PREFIX}2`,
    ]);
  });

  it('keeps the sole workspace group anchor valid for fromJSON even when its only panel was retired', () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'web-preview',
      component: 'web-preview',
      title: 'Web Preview',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    const welcome = sourceApi.getPanel(PANEL_IDS.WELCOME);
    if (welcome) {
      sourceApi.removePanel(welcome);
    }

    const sanitized = sanitizeSerializedDockview(sourceApi.toJSON());
    expect(sanitized).not.toBeNull();

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(sanitized!)).not.toThrow();
    expect(targetApi.getGroup(`${EDITOR_GROUP_PREFIX}1`)).toBeDefined();
    expect(targetApi.getGroup(`${EDITOR_GROUP_PREFIX}1`)?.panels).toHaveLength(
      0
    );
  });
});

describe('persisted layout migration and rehydration', () => {
  const serializedLayout = {
    grid: {
      root: {},
      width: 1360,
      height: 800,
      orientation: 0,
    },
    panels: {},
  } as unknown as SerializedDockview;

  it('preserves every persisted user width when upgrading from v25', () => {
    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'project-a',
        projectLayouts: {
          'project-a': {
            serializedLayout,
            rightPanelWidth: 620,
          },
          'project-b': {
            serializedLayout,
            rightPanelWidth: 700,
          },
        },
      },
      25
    );

    expect(migrated.projectLayouts['project-a'].serializedLayout).toStrictEqual(
      serializedLayout
    );
    expect(migrated.projectLayouts['project-a'].rightPanelWidth).toBe(620);
    expect(migrated.projectLayouts['project-b'].serializedLayout).toStrictEqual(
      serializedLayout
    );
    expect(migrated.projectLayouts['project-b'].rightPanelWidth).toBe(700);
    expect(migrated.serializedLayout).toStrictEqual(serializedLayout);
    expect(migrated.rightPanelWidth).toBe(620);
  });

  it('fills missing kanban zone visibility when upgrading from v26', () => {
    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'project-a',
        projectLayouts: {
          'project-a': {
            serializedLayout,
            rightPanelWidth: 620,
          },
        },
      },
      26
    );

    expect(migrated.projectLayouts['project-a'].isKanbanListVisible).toBe(true);
    expect(migrated.projectLayouts['project-a'].isKanbanMonitorVisible).toBe(
      true
    );
    expect(migrated.projectLayouts['project-a'].isKanbanSessionVisible).toBe(
      true
    );
  });

  it('keeps the fixed default limited to new project snapshots', () => {
    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'new-project',
        projectLayouts: {},
      },
      25
    );

    expect(migrated.projectLayouts['new-project'].serializedLayout).toBeNull();
    expect(migrated.projectLayouts['new-project'].rightPanelWidth).toBe(434);
  });

  it('reopens an old layout that already had a plugin panel id', () => {
    const oldLayout = {
      grid: { root: {}, width: 1360, height: 800, orientation: 0 },
      panels: {
        'plugin:vibex.host-surface/sample-panel': {
          id: 'plugin:vibex.host-surface/sample-panel',
          contentComponent: 'plugin-panel',
          title: '示例面板',
        },
        notes: {
          id: 'notes',
          contentComponent: 'notes',
          title: 'Notes',
        },
      },
    } as unknown as SerializedDockview;

    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'project-a',
        projectLayouts: {
          'project-a': {
            serializedLayout: oldLayout,
            rightPanelWidth: 480,
            activeTab: 'plugin:vibex.host-surface/sample-tab',
          },
        },
      },
      27
    );

    expect(migrated.projectLayouts['project-a'].serializedLayout).toEqual(
      oldLayout
    );
    expect(migrated.projectLayouts['project-a'].activeTab).toBe(
      'plugin:vibex.host-surface/sample-tab'
    );
    expect(migrated.activeTab).toBe('plugin:vibex.host-surface/sample-tab');
    expect(
      migrated.projectLayouts['project-a'].serializedLayout?.panels?.[
        'plugin:vibex.host-surface/sample-panel'
      ]
    ).toMatchObject({ contentComponent: 'plugin-panel' });
  });

  it('heals untouched v28 3-column startup snapshots with unbound AI_CHAT to 2-column A/B layout', () => {
    const legacyStartupLayout = {
      grid: { root: {}, width: 1440, height: 900, orientation: 0 },
      panels: {
        bots: { id: 'bots', contentComponent: 'bots', title: 'Bots' },
        welcome: {
          id: 'welcome',
          contentComponent: 'welcome',
          title: 'Welcome',
        },
        'ai-chat': {
          id: 'ai-chat',
          contentComponent: 'ai-chat',
          title: 'AI Chat',
        },
      },
    } as unknown as SerializedDockview;

    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'staller-lab',
        projectLayouts: {
          'staller-lab': {
            serializedLayout: legacyStartupLayout,
            isRightPanelVisible: true,
            rightPanelWidth: 434,
          },
        },
      },
      28
    );

    expect(migrated.projectLayouts['staller-lab'].isRightPanelVisible).toBe(
      false
    );
    expect(migrated.projectLayouts['staller-lab'].serializedLayout).toBeNull();
    expect(migrated.isRightPanelVisible).toBe(false);
    expect(migrated.serializedLayout).toBeNull();
  });

  it('migrates v27 and v29 real Dockview snapshots with retired web-preview panels into fromJSON-safe layouts', () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'preview:README.md',
      component: PANEL_IDS.PREVIEW,
      title: 'README.md',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    sourceApi.addPanel({
      id: 'web-preview',
      component: 'web-preview',
      title: 'Web Preview',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });

    const v27Snapshot = sourceApi.toJSON();
    // Simulate a v29 snapshot corrupted by the old dropRetiredWebPreviewPanels
    const v29Corrupted = sourceApi.toJSON();
    delete v29Corrupted.panels['web-preview'];

    for (const [version, snapshot] of [
      [27, v27Snapshot],
      [29, v29Corrupted],
    ] as const) {
      const migrated = migratePersistedLayoutState(
        {
          currentProjectKey: 'project-x',
          projectLayouts: {
            'project-x': {
              serializedLayout: snapshot,
              rightPanelWidth: 560,
            },
          },
        },
        version
      );

      const restored = migrated.serializedLayout;
      expect(restored).not.toBeNull();

      const targetApi = createTestDockview();
      expect(() => targetApi.fromJSON(restored!)).not.toThrow();
      expect(targetApi.getPanel('preview:README.md')).toBeDefined();
      expect(targetApi.getPanel('web-preview')).toBeUndefined();
    }
  });

  it('hydrates active project snapshot and sanitizes dangling views on same-version rehydration', async () => {
    const sourceApi = buildLiveWorkspaceLayout(createTestDockview());
    sourceApi.addPanel({
      id: 'web-preview',
      component: 'web-preview',
      title: 'Web Preview',
      position: {
        referenceGroup: `${EDITOR_GROUP_PREFIX}1`,
        direction: 'within',
      },
    });
    const dirtyLayout = sourceApi.toJSON();
    delete dirtyLayout.panels['web-preview'];

    localStorage.setItem(
      'vibex-ide-layout',
      JSON.stringify({
        version: 30,
        state: {
          currentProjectKey: 'project-rehydrate',
          projectLayouts: {
            'project-rehydrate': {
              serializedLayout: dirtyLayout,
              rightPanelWidth: 580,
              activeTab: 'kanban',
            },
          },
        },
      })
    );

    await useLayoutStore.persist.rehydrate();

    const state = useLayoutStore.getState();
    expect(state.currentProjectKey).toBe('project-rehydrate');
    expect(state.rightPanelWidth).toBe(580);
    expect(state.activeTab).toBe('kanban');
    expect(state.serializedLayout).not.toBeNull();

    const targetApi = createTestDockview();
    expect(() => targetApi.fromJSON(state.serializedLayout!)).not.toThrow();
  });

  it('bounds excess persisted projectLayouts while retaining global and active project scopes', () => {
    const projectLayouts: Record<string, { rightPanelWidth: number }> = {
      [GLOBAL_PROJECT_SCOPE]: { rightPanelWidth: 450 },
    };
    for (let i = 1; i <= 60; i += 1) {
      projectLayouts[`project-${i}`] = { rightPanelWidth: 500 + i };
    }

    const migrated = migratePersistedLayoutState(
      {
        currentProjectKey: 'project-5',
        projectLayouts,
      },
      29
    );

    const keys = Object.keys(migrated.projectLayouts);
    expect(keys.length).toBeLessThanOrEqual(50);
    expect(migrated.projectLayouts[GLOBAL_PROJECT_SCOPE]).toBeDefined();
    expect(migrated.projectLayouts['project-5']).toBeDefined();
  });
});
