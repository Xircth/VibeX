import { describe, expect, it } from 'vitest';
import type { UiPreferencesData } from 'shared/types';

import {
  uiPreferencesScratchDataToStore,
  uiPreferencesStoreToScratchData,
  type UiPreferencesStoreSnapshot,
} from './uiPreferencesScratchData';

describe('uiPreferencesScratchData', () => {
  it('serializes store state to scratch data', () => {
    const storeState: UiPreferencesStoreSnapshot = {
      repoActions: {
        'repo-1': 'pull-request',
      },
      expanded: {
        sidebar: true,
      },
      contextBarPosition: 'bottom-right',
      paneSizes: {
        left: 240,
        right: '35%',
      },
      collapsedPaths: {
        'workspace-1': ['src/generated'],
      },
      fileSearchRepoId: 'repo-1',
      isLeftSidebarVisible: false,
      isRightSidebarVisible: true,
      isTerminalVisible: false,
      workspacePanelStates: {
        'workspace-1': {
          rightMainPanelMode: 'logs',
          isLeftMainPanelVisible: false,
        },
      },
    };

    expect(uiPreferencesStoreToScratchData(storeState)).toEqual({
      repo_actions: {
        'repo-1': 'pull-request',
      },
      expanded: {
        sidebar: true,
      },
      context_bar_position: 'bottom-right',
      pane_sizes: {
        left: 240,
        right: '35%',
      },
      collapsed_paths: {
        'workspace-1': ['src/generated'],
      },
      file_search_repo_id: 'repo-1',
      is_left_sidebar_visible: false,
      is_right_sidebar_visible: true,
      is_terminal_visible: false,
      workspace_panel_states: {
        'workspace-1': {
          right_main_panel_mode: 'logs',
          is_left_main_panel_visible: false,
        },
      },
    });
  });

  it('hydrates scratch data to store state with defaults', () => {
    const scratchData: UiPreferencesData = {
      repo_actions: {
        'repo-1': 'merge',
      },
      expanded: {
        sidebar: false,
      },
      context_bar_position: null,
      pane_sizes: {},
      collapsed_paths: {},
      file_search_repo_id: null,
      is_left_sidebar_visible: null,
      is_right_sidebar_visible: false,
      is_terminal_visible: null,
      workspace_panel_states: {
        'workspace-1': {
          right_main_panel_mode: null,
          is_left_main_panel_visible: true,
        },
      },
    };

    expect(uiPreferencesScratchDataToStore(scratchData)).toEqual({
      repoActions: {
        'repo-1': 'merge',
      },
      expanded: {
        sidebar: false,
      },
      contextBarPosition: 'middle-right',
      paneSizes: {},
      collapsedPaths: {},
      fileSearchRepoId: null,
      isLeftSidebarVisible: true,
      isRightSidebarVisible: false,
      isTerminalVisible: true,
      workspacePanelStates: {
        'workspace-1': {
          rightMainPanelMode: null,
          isLeftMainPanelVisible: true,
        },
      },
    });
  });

  it('hydrates legacy project-scoped file search repo ids only when needed', () => {
    const legacyScratchData = {
      repo_actions: {},
      expanded: {},
      context_bar_position: 'top-left',
      pane_sizes: {},
      collapsed_paths: {},
      file_search_repo_id: null,
      is_left_sidebar_visible: true,
      is_right_sidebar_visible: true,
      is_terminal_visible: true,
      workspace_panel_states: {},
      file_search_repo_by_project: {
        'project-1': '',
        'project-2': 'repo-legacy',
      },
    } satisfies UiPreferencesData & {
      file_search_repo_by_project: Record<string, string>;
    };

    expect(
      uiPreferencesScratchDataToStore(legacyScratchData).fileSearchRepoId
    ).toBe('repo-legacy');

    expect(
      uiPreferencesScratchDataToStore({
        ...legacyScratchData,
        file_search_repo_id: 'repo-current',
      }).fileSearchRepoId
    ).toBe('repo-current');
  });
});
