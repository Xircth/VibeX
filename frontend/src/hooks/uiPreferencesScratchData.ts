import type {
  JsonValue,
  UiPreferencesData,
  WorkspacePanelStateData,
} from 'shared/types';
import type {
  ContextBarPosition,
  RepoAction,
  RightMainPanelMode,
  WorkspacePanelState,
} from '@/stores/useUiPreferencesStore';

export type UiPreferencesStoreSnapshot = {
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  workspacePanelStates: Record<string, WorkspacePanelState>;
};

type LegacyUiPreferencesData = UiPreferencesData & {
  file_search_repo_by_project?: Record<string, string>;
};

export function uiPreferencesStoreToScratchData(
  state: UiPreferencesStoreSnapshot
): UiPreferencesData {
  const workspacePanelStates: Record<string, WorkspacePanelStateData> = {};
  for (const [key, value] of Object.entries(state.workspacePanelStates)) {
    workspacePanelStates[key] = {
      right_main_panel_mode: value.rightMainPanelMode,
      is_left_main_panel_visible: value.isLeftMainPanelVisible,
    };
  }

  return {
    repo_actions: state.repoActions as Record<string, string>,
    expanded: state.expanded,
    context_bar_position: state.contextBarPosition,
    pane_sizes: state.paneSizes as Record<string, JsonValue>,
    collapsed_paths: state.collapsedPaths,
    file_search_repo_id: state.fileSearchRepoId,
    is_left_sidebar_visible: state.isLeftSidebarVisible,
    is_right_sidebar_visible: state.isRightSidebarVisible,
    is_terminal_visible: state.isTerminalVisible,
    workspace_panel_states: workspacePanelStates,
  };
}

export function uiPreferencesScratchDataToStore(
  data: UiPreferencesData
): UiPreferencesStoreSnapshot {
  const workspacePanelStates: Record<string, WorkspacePanelState> = {};
  if (data.workspace_panel_states) {
    for (const [key, value] of Object.entries(data.workspace_panel_states)) {
      if (value) {
        workspacePanelStates[key] = {
          rightMainPanelMode:
            (value.right_main_panel_mode as RightMainPanelMode) ?? null,
          isLeftMainPanelVisible: value.is_left_main_panel_visible ?? true,
        };
      }
    }
  }

  const legacyFileSearchRepoId = Object.values(
    (data as LegacyUiPreferencesData).file_search_repo_by_project ?? {}
  ).find(Boolean);

  return {
    repoActions: (data.repo_actions ?? {}) as Record<string, RepoAction>,
    expanded: (data.expanded ?? {}) as Record<string, boolean>,
    contextBarPosition:
      (data.context_bar_position as ContextBarPosition) ?? 'middle-right',
    paneSizes: (data.pane_sizes ?? {}) as Record<string, number | string>,
    collapsedPaths: (data.collapsed_paths ?? {}) as Record<string, string[]>,
    fileSearchRepoId:
      data.file_search_repo_id ?? legacyFileSearchRepoId ?? null,
    isLeftSidebarVisible: data.is_left_sidebar_visible ?? true,
    isRightSidebarVisible: data.is_right_sidebar_visible ?? true,
    isTerminalVisible: data.is_terminal_visible ?? true,
    workspacePanelStates,
  };
}
