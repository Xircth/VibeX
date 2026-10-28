import { create } from 'zustand';

export type CollaborationSessionFocus = {
  conversationId: string;
  memberId: string;
  memberName: string;
  threadId: string;
  threadKind: string;
  threadName: string;
};

export type CollaborationSpaceCursorState = {
  cursor: number;
  generation: number;
};

export interface CollaborationLayoutState {
  isSpacesVisible: boolean;
  isThreadVisible: boolean;
  isPreviewVisible: boolean;
  hasOpenedSpaceThread: boolean;
  hasMountedPreviewTabs: boolean;
  sessionFocus: CollaborationSessionFocus | null;
  spaceCursors: Record<string, CollaborationSpaceCursorState>;
  setSpacesVisible: (visible: boolean) => void;
  toggleSpacesVisible: () => void;
  setThreadVisible: (visible: boolean) => void;
  toggleThreadVisible: () => void;
  setPreviewVisible: (visible: boolean) => void;
  togglePreviewVisible: () => void;
  setHasOpenedSpaceThread: (hasTarget: boolean) => void;
  setHasMountedPreviewTabs: (hasTarget: boolean) => void;
  requestSessionFocus: (focus: CollaborationSessionFocus) => void;
  consumeSessionFocus: () => void;
  setSpaceCursor: (
    spaceId: string,
    state: CollaborationSpaceCursorState
  ) => void;
  clearSpaceCursor: (spaceId?: string) => void;
  resetCollaborationLayout: () => void;
}

export const useCollaborationLayoutStore = create<CollaborationLayoutState>(
  (set) => ({
    isSpacesVisible: true,
    isThreadVisible: true,
    isPreviewVisible: true,
    hasOpenedSpaceThread: false,
    hasMountedPreviewTabs: false,
    sessionFocus: null,
    spaceCursors: {},

    setSpacesVisible: (visible) => set({ isSpacesVisible: visible }),

    toggleSpacesVisible: () =>
      set((state) => {
        if (!state.isSpacesVisible) {
          return { isSpacesVisible: true };
        }
        const threadVisible =
          state.hasOpenedSpaceThread && state.isThreadVisible;
        const previewVisible =
          state.hasMountedPreviewTabs && state.isPreviewVisible;
        if (!threadVisible && !previewVisible) {
          return state;
        }
        return { isSpacesVisible: false };
      }),

    setThreadVisible: (visible) => set({ isThreadVisible: visible }),

    toggleThreadVisible: () =>
      set((state) => {
        if (!state.hasOpenedSpaceThread) {
          return state;
        }
        if (!state.isThreadVisible) {
          return { isThreadVisible: true };
        }
        const previewVisible =
          state.hasMountedPreviewTabs && state.isPreviewVisible;
        if (!state.isSpacesVisible && !previewVisible) {
          return state;
        }
        return { isThreadVisible: false };
      }),

    setPreviewVisible: (visible) => set({ isPreviewVisible: visible }),

    togglePreviewVisible: () =>
      set((state) => {
        if (!state.hasMountedPreviewTabs) {
          return state;
        }
        if (!state.isPreviewVisible) {
          return { isPreviewVisible: true };
        }
        const threadVisible =
          state.hasOpenedSpaceThread && state.isThreadVisible;
        if (!state.isSpacesVisible && !threadVisible) {
          return state;
        }
        return { isPreviewVisible: false };
      }),

    setHasOpenedSpaceThread: (hasTarget) =>
      set((state) => {
        if (state.hasOpenedSpaceThread === hasTarget) {
          return state;
        }
        if (
          !hasTarget &&
          !state.isSpacesVisible &&
          !(state.hasMountedPreviewTabs && state.isPreviewVisible)
        ) {
          return { hasOpenedSpaceThread: false, isSpacesVisible: true };
        }
        return { hasOpenedSpaceThread: hasTarget };
      }),

    setHasMountedPreviewTabs: (hasTarget) =>
      set((state) => {
        if (state.hasMountedPreviewTabs === hasTarget) {
          return state;
        }
        if (
          !hasTarget &&
          !state.isSpacesVisible &&
          !(state.hasOpenedSpaceThread && state.isThreadVisible)
        ) {
          return { hasMountedPreviewTabs: false, isSpacesVisible: true };
        }
        return { hasMountedPreviewTabs: hasTarget };
      }),

    requestSessionFocus: (focus) => set({ sessionFocus: focus }),

    consumeSessionFocus: () => set({ sessionFocus: null }),

    setSpaceCursor: (spaceId, cursorState) =>
      set((state) => ({
        spaceCursors: {
          ...state.spaceCursors,
          [spaceId]: cursorState,
        },
      })),

    clearSpaceCursor: (spaceId) =>
      set((state) => {
        if (!spaceId) {
          return { spaceCursors: {} };
        }
        const next = { ...state.spaceCursors };
        delete next[spaceId];
        return { spaceCursors: next };
      }),

    resetCollaborationLayout: () =>
      set((state) => ({
        isSpacesVisible: true,
        isThreadVisible: true,
        isPreviewVisible: true,
        hasOpenedSpaceThread: false,
        hasMountedPreviewTabs: false,
        sessionFocus: state.sessionFocus,
        spaceCursors: {},
      })),
  })
);
