import { useCallback, useEffect, useRef } from 'react';
import { useScratch } from './useScratch';
import { useDebouncedCallback } from './useDebouncedCallback';
import {
  ScratchType,
  type ScratchPayload,
  type UiPreferencesData,
} from 'shared/types';
import { useUiPreferencesStore } from '@/stores/useUiPreferencesStore';
import {
  uiPreferencesScratchDataToStore,
  uiPreferencesStoreToScratchData,
} from './uiPreferencesScratchData';

// Stable UUID for global UI preferences (not tied to a workspace/user)
// This is a deterministic UUID v5 generated from the namespace "ui-preferences"
// Using a fixed UUID ensures all users/sessions share the same preferences record
const UI_PREFERENCES_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Hook that syncs UI preferences between Zustand store and server scratch storage.
 * Should be used once at the app root level.
 */
export function useUiPreferencesScratch() {
  const { scratch, updateScratch, isLoading, isConnected } = useScratch(
    ScratchType.UI_PREFERENCES,
    UI_PREFERENCES_ID
  );

  // Track whether we've initialized from server
  const hasInitializedRef = useRef(false);
  // Track whether we're currently applying server data to prevent save loops
  const isApplyingServerDataRef = useRef(false);

  // Get current store state
  const storeState = useUiPreferencesStore((state) => ({
    repoActions: state.repoActions,
    expanded: state.expanded,
    contextBarPosition: state.contextBarPosition,
    paneSizes: state.paneSizes,
    collapsedPaths: state.collapsedPaths,
    fileSearchRepoId: state.fileSearchRepoId,
    isLeftSidebarVisible: state.isLeftSidebarVisible,
    isRightSidebarVisible: state.isRightSidebarVisible,
    isTerminalVisible: state.isTerminalVisible,
    workspacePanelStates: state.workspacePanelStates,
  }));

  // Extract scratch data
  const payload = scratch?.payload as ScratchPayload | undefined;
  const scratchData: UiPreferencesData | undefined =
    payload?.type === 'UI_PREFERENCES' ? payload.data : undefined;

  // Save to server function
  const saveToServer = useCallback(async () => {
    if (isApplyingServerDataRef.current || !hasInitializedRef.current) {
      return;
    }

    const currentState = useUiPreferencesStore.getState();
    const data = uiPreferencesStoreToScratchData({
      repoActions: currentState.repoActions,
      expanded: currentState.expanded,
      contextBarPosition: currentState.contextBarPosition,
      paneSizes: currentState.paneSizes,
      collapsedPaths: currentState.collapsedPaths,
      fileSearchRepoId: currentState.fileSearchRepoId,
      isLeftSidebarVisible: currentState.isLeftSidebarVisible,
      isRightSidebarVisible: currentState.isRightSidebarVisible,
      isTerminalVisible: currentState.isTerminalVisible,
      workspacePanelStates: currentState.workspacePanelStates,
    });

    try {
      await updateScratch({
        payload: {
          type: 'UI_PREFERENCES',
          data,
        },
      });
    } catch (e) {
      console.error('[useUiPreferencesScratch] Failed to save:', e);
    }
  }, [updateScratch]);

  const { debounced: debouncedSave } = useDebouncedCallback(saveToServer, 500);

  // Initialize store from server data when first loaded
  useEffect(() => {
    if (hasInitializedRef.current || isLoading || !isConnected) {
      return;
    }

    hasInitializedRef.current = true;

    if (scratchData) {
      // Server has data - apply it to store
      isApplyingServerDataRef.current = true;
      const serverState = uiPreferencesScratchDataToStore(scratchData);

      // Merge server state into the store
      useUiPreferencesStore.setState({
        repoActions: serverState.repoActions,
        expanded: serverState.expanded,
        contextBarPosition: serverState.contextBarPosition,
        paneSizes: serverState.paneSizes,
        collapsedPaths: serverState.collapsedPaths,
        fileSearchRepoId: serverState.fileSearchRepoId,
        isLeftSidebarVisible: serverState.isLeftSidebarVisible,
        isRightSidebarVisible: serverState.isRightSidebarVisible,
        isTerminalVisible: serverState.isTerminalVisible,
        workspacePanelStates: serverState.workspacePanelStates,
      });

      // Allow a brief delay for state to settle
      setTimeout(() => {
        isApplyingServerDataRef.current = false;
      }, 100);
    }
  }, [isLoading, isConnected, scratchData]);

  // Subscribe to store changes and save to server
  useEffect(() => {
    const unsubscribe = useUiPreferencesStore.subscribe(() => {
      if (!isApplyingServerDataRef.current && hasInitializedRef.current) {
        debouncedSave();
      }
    });

    return unsubscribe;
  }, [debouncedSave]);

  return {
    isLoading,
    isConnected,
    // Expose for debugging
    scratchData,
    storeState,
  };
}
