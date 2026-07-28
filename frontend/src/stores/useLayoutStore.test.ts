import { describe, it, expect, beforeEach } from 'vitest';
import {
  useLayoutStore,
  PANEL_IDS,
  GROUP_IDS,
  EDITOR_GROUP_PREFIX,
  MAX_EDITOR_GROUPS,
  migratePersistedLayoutState,
} from './useLayoutStore';
import type { SerializedDockview } from 'dockview';

describe('useLayoutStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useLayoutStore.getState().resetLayout();
  });

  describe('initial state', () => {
    it('should have file tree visible by default', () => {
      expect(useLayoutStore.getState().isFileTreeVisible).toBe(true);
    });

    it('should have right panel visible by default', () => {
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(true);
    });

    it('should have the 30%-smaller default right panel width', () => {
      expect(useLayoutStore.getState().rightPanelWidth).toBe(434);
    });

    it('should have kanban as active tab by default', () => {
      expect(useLayoutStore.getState().activeTab).toBe('kanban');
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
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(true);

      useLayoutStore.getState().toggleRightPanel();
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(false);

      useLayoutStore.getState().toggleRightPanel();
      expect(useLayoutStore.getState().isRightPanelVisible).toBe(true);
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
      store.setRightPanelVisible(false);
      store.setActiveTab('workspace');

      store.resetLayout();

      const reset = useLayoutStore.getState();
      expect(reset.isFileTreeVisible).toBe(true);
      expect(reset.rightPanelWidth).toBe(434);
      expect(reset.isRightPanelVisible).toBe(true);
      expect(reset.activeTab).toBe('workspace');
      expect(reset.serializedLayout).toBeNull();
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

describe('persisted layout migration', () => {
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

    expect(migrated.projectLayouts['project-a'].serializedLayout).toBe(
      serializedLayout
    );
    expect(migrated.projectLayouts['project-a'].rightPanelWidth).toBe(620);
    expect(migrated.projectLayouts['project-b'].serializedLayout).toBe(
      serializedLayout
    );
    expect(migrated.projectLayouts['project-b'].rightPanelWidth).toBe(700);
    expect(migrated.serializedLayout).toBe(serializedLayout);
    expect(migrated.rightPanelWidth).toBe(620);
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
});
