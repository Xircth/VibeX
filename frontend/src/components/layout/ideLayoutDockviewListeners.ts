import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  DockviewIDisposable,
  DockviewWillShowOverlayLocationEvent,
  SerializedDockview,
} from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import {
  findCanvasBoundarySash,
  type CanvasStageInsets,
} from '@/components/layout/canvasStageInsets';
import {
  closeEmptyTabBarGroups,
  defaultSessionWidth,
  scheduleCloseEmptyTabBarGroups,
  dismissEditorColumnAfterLastTab,
  getEditorGroups,
  getLeftGroup,
  getRightGroup,
  IDE_LAYOUT_SIZING,
  normalizeGroupIds,
  recreateWelcomeEditorGroup,
  zoneOrderMatchesArrangement,
  type DockviewGroup,
} from '@/components/layout/ideLayoutGroupNormalization';
import {
  getLayoutArrangement,
  slotOfZone,
  type LayoutArrangement,
} from '@/lib/layoutArrangement';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  MAX_EDITOR_GROUPS,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import {
  captureZoneColumnWidths,
  installEditorColumnWidthRebalance,
  restoreFlexibleEditorColumn,
  setColumnVisible,
  setSessionDockVisible,
  shouldPersistSessionColumnWidth,
} from '@/utils/dockviewEditorGroup';
import {
  BOTTOM_PANEL_IDS,
  getNextEditorGroupId,
  getNextRightGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  isSessionPanelId,
  LEFT_GROUP_PREFIX,
  LEFT_PANEL_IDS,
  listLeftDockGroups,
  listSessionGroups,
  RIGHT_GROUP_PREFIX,
} from '@/utils/dockviewGroupPolicy';
import {
  assignDockviewGroupIdAndRole,
  setDockviewGroupRole,
} from '@/utils/dockviewGroupRole';
import { installDockviewPointerTabDnd } from '@/utils/dockviewPointerTabDnd';
import { isDockviewApiDisposed } from '@/utils/dockviewSessionPanel';
import {
  layoutDockviewPreservingGroupWidths,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import { applyWorkspaceZoneConstraints } from '@/utils/dockviewWorkspaceConstraints';
import { shouldDismissEditorColumnAfterPanelRemoval } from '@/utils/lastPreviewTabLayout';

export type DropTargetZone = 'editor' | 'session' | null;

export function registerDockviewOverlayDropGuard(
  api: DockviewApi,
  lastDropTargetZoneRef: { current: DropTargetZone }
): DockviewIDisposable {
  const clearDropTargetZone = () => {
    lastDropTargetZoneRef.current = null;
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      lastDropTargetZoneRef.current = null;
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('dragend', clearDropTargetZone, true);
    window.addEventListener('pointercancel', clearDropTargetZone, true);
    window.addEventListener('keydown', handleKeyDown, true);
  }

  const overlayDisposable = api.onWillShowOverlay((event) => {
    const ev: DockviewWillShowOverlayLocationEvent = event;
    if (ev.kind === 'edge') {
      event.preventDefault();
      return;
    }

    const targetGroup = ev.group;
    const panelData = ev.getData?.();
    const draggedPanelId = panelData?.panelId ?? ev.panel?.id;

    if (!targetGroup || !draggedPanelId) {
      return;
    }

    const sourceGroup = panelData?.groupId
      ? api.getGroup(panelData.groupId)
      : undefined;
    const isSourceLeftPanel = sourceGroup
      ? isLeftGroup(sourceGroup)
      : LEFT_PANEL_IDS.has(draggedPanelId);
    const isSourceBottomPanel = sourceGroup
      ? isBottomGroup(sourceGroup)
      : BOTTOM_PANEL_IDS.has(draggedPanelId);
    const isTargetLeftGroup = isLeftGroup(targetGroup);
    const isTargetBottomGroup = isBottomGroup(targetGroup);
    const isTargetEditorGroup = isEditorGroup(targetGroup);
    const isTargetSessionGroup = isSessionGroup(targetGroup);

    if (isSourceBottomPanel || isTargetBottomGroup) {
      event.preventDefault();
      return;
    }

    if (isTargetLeftGroup && !isSourceLeftPanel) {
      event.preventDefault();
      return;
    }

    if (isSourceLeftPanel && !isTargetLeftGroup) {
      event.preventDefault();
      return;
    }

    if (
      isTargetEditorGroup &&
      getEditorGroups(api).length >= MAX_EDITOR_GROUPS &&
      ev.position !== 'center' &&
      ev.kind === 'content'
    ) {
      event.preventDefault();
      return;
    }

    if (
      isTargetSessionGroup &&
      listSessionGroups(api.groups).length >= MAX_EDITOR_GROUPS &&
      ev.position !== 'center' &&
      ev.kind === 'content'
    ) {
      event.preventDefault();
      return;
    }

    lastDropTargetZoneRef.current = isTargetSessionGroup
      ? 'session'
      : isTargetEditorGroup
        ? 'editor'
        : null;
  });

  return {
    dispose() {
      overlayDisposable.dispose();
      lastDropTargetZoneRef.current = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('dragend', clearDropTargetZone, true);
        window.removeEventListener('pointercancel', clearDropTargetZone, true);
        window.removeEventListener('keydown', handleKeyDown, true);
      }
    },
  };
}

export interface AttachDockviewWorkspaceListenersOptions {
  apiRef: { current: DockviewApi | null };
  dockviewRootEl: HTMLDivElement | null;
  isResettingRef: { current: boolean };
  isCollapsedRef: { current: boolean };
  lastDropTargetZoneRef: { current: DropTargetZone };
  layoutChangeTimerRef: { current: ReturnType<typeof setTimeout> | null };
  lastSelfHealAtRef: { current: number };
  registerDndGuard: (api: DockviewApi) => DockviewIDisposable;
  applyArrangement: (
    api: DockviewApi,
    nextArrangement: LayoutArrangement
  ) => void;
  setSerializedLayout: (layout: SerializedDockview | null) => void;
  setRightPanelWidth: (width: number) => void;
}

export function attachDockviewWorkspaceListeners(
  api: DockviewApi,
  options: AttachDockviewWorkspaceListenersOptions
): () => void {
  const {
    apiRef,
    dockviewRootEl,
    isResettingRef,
    isCollapsedRef,
    lastDropTargetZoneRef,
    layoutChangeTimerRef,
    lastSelfHealAtRef,
    registerDndGuard,
    applyArrangement,
    setSerializedLayout,
    setRightPanelWidth,
  } = options;

  let resizeFrame: number | null = null;
  const dockviewResizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;

    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;

    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
    }
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (apiRef.current !== api || isDockviewApiDisposed(api)) return;

      const arrangement = getLayoutArrangement();
      const dockGroups =
        slotOfZone(arrangement, 'dock') !== 'center' &&
        slotOfZone(arrangement, 'dock') !== 'bottom'
          ? listLeftDockGroups(api.groups)
          : [];
      const sideGroups = [
        ...(dockGroups.length > 0
          ? dockGroups
          : slotOfZone(arrangement, 'dock') !== 'center' &&
              slotOfZone(arrangement, 'dock') !== 'bottom'
            ? [getLeftGroup(api)]
            : []),
        slotOfZone(arrangement, 'session') !== 'center' &&
        slotOfZone(arrangement, 'session') !== 'bottom'
          ? getRightGroup(api)
          : null,
      ].filter((group): group is DockviewGroup => Boolean(group));

      applyWorkspaceZoneConstraints(api, width);
      layoutDockviewPreservingGroupWidths(api, sideGroups, width, height);
    });
  });
  if (dockviewRootEl) {
    dockviewResizeObserver.observe(dockviewRootEl);
  }

  const pointerTabDndDisposable = dockviewRootEl
    ? installDockviewPointerTabDnd(dockviewRootEl)
    : null;
  const dndGuardDisposable = registerDndGuard(api);
  let isInternalAnchorSync = false;

  const removePanelDisposable = api.onDidRemovePanel((panel) => {
    if (isResettingRef.current) return;

    const sessionGroupsHavePanels = listSessionGroups(api.groups).some(
      (group) => group.panels.length > 0
    );
    if (
      !sessionGroupsHavePanels &&
      (isSessionPanelId(panel.id) ||
        useLayoutStore.getState().isRightPanelVisible)
    ) {
      const leftGroup = getLeftGroup(api);
      const dockWidthBefore = leftGroup?.api.isVisible
        ? leftGroup.api.width
        : undefined;
      useLayoutStore.getState().setRightPanelVisible(false);
      setSessionDockVisible(api, getLayoutArrangement(), false);
      const hasVisibleEditorPanels = getEditorGroups(api).some(
        (group) => group.api.isVisible && group.panels.length > 0
      );
      if (!hasVisibleEditorPanels) {
        const welcomeGroup = recreateWelcomeEditorGroup(api);
        if (welcomeGroup) {
          setColumnVisible(api, getLayoutArrangement(), welcomeGroup, true);
          restoreFlexibleEditorColumn(
            api,
            getLayoutArrangement(),
            useLayoutStore.getState().rightPanelWidth,
            dockWidthBefore
          );
          api.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
        }
      }
      normalizeGroupIds(api);
      scheduleCloseEmptyTabBarGroups(api);
      return;
    }

    normalizeGroupIds(api);
    const editorGroups = getEditorGroups(api);
    const hasEditorPanels = editorGroups.some(
      (group) => group.panels.length > 0
    );
    const hasVisibleSessionPanels = listSessionGroups(api.groups).some(
      (group) => group.api.isVisible && group.panels.length > 0
    );

    if (
      shouldDismissEditorColumnAfterPanelRemoval(panel, editorGroups) ||
      (!hasEditorPanels && !LEFT_PANEL_IDS.has(panel.id))
    ) {
      if (hasVisibleSessionPanels) {
        dismissEditorColumnAfterLastTab(api);
      } else {
        const leftGroup = getLeftGroup(api);
        const dockWidthBefore = leftGroup?.api.isVisible
          ? leftGroup.api.width
          : undefined;
        const welcomeGroup = recreateWelcomeEditorGroup(api);
        if (welcomeGroup) {
          setColumnVisible(api, getLayoutArrangement(), welcomeGroup, true);
          restoreFlexibleEditorColumn(
            api,
            getLayoutArrangement(),
            useLayoutStore.getState().rightPanelWidth,
            dockWidthBefore
          );
          api.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
        }
      }
    }
    scheduleCloseEmptyTabBarGroups(api);
  });

  const normalizeGroupsDisposable = api.onDidAddGroup((group) => {
    if (!isResettingRef.current) {
      const isUnassignedGroupId =
        group.id !== GROUP_IDS.LEFT &&
        !group.id.startsWith(LEFT_GROUP_PREFIX) &&
        !group.id.startsWith(EDITOR_GROUP_PREFIX) &&
        group.id !== GROUP_IDS.RIGHT &&
        !group.id.startsWith(RIGHT_GROUP_PREFIX) &&
        group.id !== GROUP_IDS.BOTTOM;
      if (lastDropTargetZoneRef.current === 'session' && isUnassignedGroupId) {
        assignDockviewGroupIdAndRole(
          api,
          group,
          getNextRightGroupId(api),
          'session'
        );
        group.element?.setAttribute('data-session-dock', 'true');
      } else if (
        lastDropTargetZoneRef.current === 'editor' &&
        isUnassignedGroupId
      ) {
        assignDockviewGroupIdAndRole(
          api,
          group,
          getNextEditorGroupId(api),
          'editor'
        );
        group.element?.removeAttribute('data-session-dock');
      }
      lastDropTargetZoneRef.current = null;
      normalizeGroupIds(api);
    }
  });

  const movePanelDisposable = api.onDidMovePanel(({ panel, from }) => {
    if (isResettingRef.current) return;

    if (panel.group === from) {
      if (lastDropTargetZoneRef.current === 'editor' && isSessionGroup(from)) {
        from.element?.removeAttribute('data-session-dock');
        assignDockviewGroupIdAndRole(
          api,
          from,
          getNextEditorGroupId(api),
          'editor'
        );
      } else if (
        lastDropTargetZoneRef.current === 'session' &&
        isEditorGroup(from)
      ) {
        from.element?.setAttribute('data-session-dock', 'true');
        assignDockviewGroupIdAndRole(
          api,
          from,
          getNextRightGroupId(api),
          'session'
        );
      }
    }
    lastDropTargetZoneRef.current = null;

    if (getEditorGroups(api).length === 0 && !isCollapsedRef.current) {
      recreateWelcomeEditorGroup(api);
    }

    if (listSessionGroups(api.groups).length === 0) {
      if (useLayoutStore.getState().isRightPanelVisible) {
        useLayoutStore.getState().setRightPanelVisible(false);
      }
      const editorGroups = getEditorGroups(api);
      const referenceGroup =
        editorGroups[editorGroups.length - 1] ?? getLeftGroup(api);
      const referencePanel = referenceGroup?.panels[0];
      if (referencePanel) {
        const preVisibleTargets = captureZoneColumnWidths(api).map((col) => ({
          group: col.group,
          width: col.width,
        }));
        isInternalAnchorSync = true;
        try {
          const rightGroup = api.addGroup({
            id: GROUP_IDS.RIGHT,
            referencePanel,
            direction: 'right',
            constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
            initialWidth:
              useLayoutStore.getState().rightPanelWidth ||
              defaultSessionWidth(api.width),
          });
          setDockviewGroupRole(rightGroup, 'session');
          rightGroup.element?.setAttribute('data-session-dock', 'true');
          rightGroup.api.setVisible(false);
          if (preVisibleTargets.length > 0) {
            settleDockviewGroupWidths(preVisibleTargets);
          }
        } finally {
          isInternalAnchorSync = false;
        }
      }
    }

    normalizeGroupIds(api);
    scheduleCloseEmptyTabBarGroups(api);
  });

  const removeGroupDisposable = api.onDidRemoveGroup(() => {
    if (!isResettingRef.current) {
      normalizeGroupIds(api);
    }
  });

  const columnWidthRebalance = installEditorColumnWidthRebalance(api, {
    shouldRebalance: () => !isResettingRef.current && !isInternalAnchorSync,
  });

  let layoutPersistIdleHandle: number | null = null;
  const cancelPendingIdlePersist = () => {
    if (
      layoutPersistIdleHandle !== null &&
      typeof cancelIdleCallback === 'function'
    ) {
      cancelIdleCallback(layoutPersistIdleHandle);
    }
    layoutPersistIdleHandle = null;
  };

  const layoutDisposable = api.onDidLayoutChange(() => {
    if (isResettingRef.current) return;

    if (layoutChangeTimerRef.current) {
      clearTimeout(layoutChangeTimerRef.current);
    }
    cancelPendingIdlePersist();

    layoutChangeTimerRef.current = setTimeout(() => {
      layoutChangeTimerRef.current = null;
      if (
        isResettingRef.current ||
        apiRef.current !== api ||
        isDockviewApiDisposed(api)
      ) {
        return;
      }

      normalizeGroupIds(api);
      closeEmptyTabBarGroups(api);

      // Self-heal: if some code path re-created a zone group in the
      // wrong column, snap the grid back to the configured arrangement.
      // Cooldown guards against churn if a mismatch were ever persistent.
      const currentArrangement = getLayoutArrangement();
      if (
        !zoneOrderMatchesArrangement(api, currentArrangement) &&
        Date.now() - lastSelfHealAtRef.current > 5000
      ) {
        lastSelfHealAtRef.current = Date.now();
        applyArrangement(api, currentArrangement);
        return;
      }

      const persistLayout = () => {
        layoutPersistIdleHandle = null;
        if (
          isResettingRef.current ||
          apiRef.current !== api ||
          isDockviewApiDisposed(api)
        ) {
          return;
        }

        try {
          setSerializedLayout(api.toJSON());
        } catch {
          // Ignore serialization failures during transient layout states.
        }

        // Keep the stored session width in sync so default rebuilds and
        // cross-slot moves reuse the user's last column width. Center and
        // bottom slots are skipped: there the group width is the flexible
        // remainder / plain column width, not a meaningful column memory.
        // A crushed editor column is also skipped: the session has absorbed
        // leftover space, and that expanded width is not user intent.
        try {
          const rightGroup = getRightGroup(api);
          const sessionSlot = slotOfZone(getLayoutArrangement(), 'session');
          if (
            rightGroup?.api.isVisible &&
            sessionSlot !== 'center' &&
            sessionSlot !== 'bottom' &&
            rightGroup.api.width > 0 &&
            shouldPersistSessionColumnWidth(api) &&
            rightGroup.api.width !== useLayoutStore.getState().rightPanelWidth
          ) {
            setRightPanelWidth(rightGroup.api.width);
          }
        } catch {
          // Ignore width sync failures during transient layout states.
        }
      };

      if (typeof requestIdleCallback === 'function') {
        layoutPersistIdleHandle = requestIdleCallback(persistLayout, {
          timeout: IDE_LAYOUT_SIZING.IDLE_PERSIST_TIMEOUT_MS,
        });
      } else {
        persistLayout();
      }
    }, IDE_LAYOUT_SIZING.LAYOUT_CHANGE_DEBOUNCE_MS);
  });

  return () => {
    dockviewResizeObserver.disconnect();
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
    }
    pointerTabDndDisposable?.dispose();
    dndGuardDisposable.dispose();
    removePanelDisposable.dispose();
    normalizeGroupsDisposable.dispose();
    movePanelDisposable.dispose();
    removeGroupDisposable.dispose();
    columnWidthRebalance.dispose();
    layoutDisposable.dispose();

    if (layoutChangeTimerRef.current) {
      clearTimeout(layoutChangeTimerRef.current);
      layoutChangeTimerRef.current = null;
    }
    cancelPendingIdlePersist();
  };
}

export interface TabBarDropPanelActions {
  openFilePreview: (
    target: string,
    options?: { title?: string; activate?: boolean; mode?: 'diff' }
  ) => void;
  openOrFocusPanel: (
    panelId: string,
    title: string,
    params?: Record<string, unknown>
  ) => void;
}

export function routeWorkspaceTabBarDrop(
  rawData: string,
  panelActions: TabBarDropPanelActions
): void {
  try {
    const payload = JSON.parse(rawData) as {
      id?: string;
      title?: string;
      component?: string;
      params?: {
        filePath?: string;
        commitSha?: string;
        [key: string]: unknown;
      };
    };

    if (payload.component === 'preview' && payload.params?.filePath) {
      panelActions.openFilePreview(payload.params.filePath, {
        title: payload.title,
        activate: true,
      });
    } else if (payload.component === 'preview' && payload.params?.commitSha) {
      panelActions.openFilePreview(payload.params.commitSha, {
        title: payload.title,
        activate: true,
        mode: 'diff',
      });
    } else if (payload.component && payload.id) {
      panelActions.openOrFocusPanel(
        payload.id,
        payload.title ?? payload.id,
        payload.params
      );
    }
  } catch (error) {
    console.warn('[TabBarDrop] Failed to parse drop payload:', error);
  }
}

export function forwardPointerDownToCanvasBoundarySash(
  host: HTMLDivElement | null,
  insets: CanvasStageInsets,
  side: 'left' | 'right',
  event: ReactPointerEvent<HTMLDivElement>
): void {
  if (!host || event.button !== 0) return;
  const bestSash = findCanvasBoundarySash(host, insets, side);
  if (!bestSash) return;
  event.preventDefault();
  event.stopPropagation();
  bestSash.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      buttons: event.buttons || 1,
    })
  );
}
