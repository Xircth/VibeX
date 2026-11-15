import { useLayoutEffect, useState, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { LayoutArrangement } from '@/lib/layoutArrangement';
import { getGroupElement } from '@/utils/dockviewGroupPolicy';
import { getLiveDockviewApi } from '@/utils/dockviewSessionPanel';
import {
  measureCanvasStageInsets,
  type CanvasStageInsets,
} from './canvasStageInsets';

interface UseWorkspaceStageInsetsOptions {
  enabled: boolean;
  apiRef: RefObject<DockviewApi | null>;
  readyDockviewApi: DockviewApi | null;
  dockviewRootRef: RefObject<HTMLDivElement | null>;
  arrangement: LayoutArrangement;
  isDockviewMounted: boolean;
  serializedLayout: unknown;
}

/**
 * Tracks the pixel `{ left, right }` insets occupied by Zone A shell navigation
 * panels so Zone B overlays (Infinite Canvas stage and Free Tabs global creation
 * masks) cover the exact Zone B rectangle without affecting Zone A/B widths.
 */
export function useWorkspaceStageInsets({
  enabled,
  apiRef,
  readyDockviewApi,
  dockviewRootRef,
  arrangement,
  isDockviewMounted,
  serializedLayout,
}: UseWorkspaceStageInsetsOptions): CanvasStageInsets {
  const [stageInsets, setStageInsets] = useState<CanvasStageInsets>({
    left: 0,
    right: 0,
  });

  useLayoutEffect(() => {
    if (!enabled) return;

    const resolveLiveApi = () =>
      getLiveDockviewApi(apiRef.current) ??
      getLiveDockviewApi(readyDockviewApi);

    const measureInsets = () => {
      const next = measureCanvasStageInsets(
        resolveLiveApi(),
        dockviewRootRef.current,
        arrangement
      );
      setStageInsets((prev) =>
        prev.left === next.left && prev.right === next.right ? prev : next
      );
    };

    const api = resolveLiveApi();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measureInsets())
        : null;
    const groupDisposables: Array<{ dispose: () => void }> = [];
    const clearGroupObservers = () => {
      while (groupDisposables.length > 0) {
        groupDisposables.pop()?.dispose();
      }
      resizeObserver?.disconnect();
    };

    const syncGroupObservers = () => {
      clearGroupObservers();
      const host = dockviewRootRef.current;
      if (resizeObserver && host) {
        resizeObserver.observe(host);
      }
      const currentApi = resolveLiveApi();
      if (!currentApi) return;
      for (const group of currentApi.groups) {
        if (group.api?.onDidDimensionsChange) {
          groupDisposables.push(
            group.api.onDidDimensionsChange(() => measureInsets())
          );
        }
        if (group.api?.onDidVisibilityChange) {
          groupDisposables.push(
            group.api.onDidVisibilityChange(() => measureInsets())
          );
        }
        if (resizeObserver) {
          const el = getGroupElement(group);
          if (el) {
            resizeObserver.observe(el);
            if (el.parentElement) {
              resizeObserver.observe(el.parentElement);
            }
          }
        }
      }
    };

    syncGroupObservers();
    measureInsets();

    const handleStructureChange = () => {
      syncGroupObservers();
      measureInsets();
    };
    const apiDisposables = [
      api?.onDidLayoutChange(handleStructureChange),
      api?.onDidAddGroup(handleStructureChange),
      api?.onDidRemoveGroup(handleStructureChange),
      api?.onDidMovePanel(handleStructureChange),
    ];

    let removeSashMoveListeners: (() => void) | null = null;
    const handlePointerDownCapture = (event: PointerEvent) => {
      const target = event.target;
      const host = dockviewRootRef.current;
      if (!(target instanceof Element) || !host || !host.contains(target)) {
        return;
      }
      if (!target.closest('.dv-sash')) return;
      removeSashMoveListeners?.();
      const onMove = () => measureInsets();
      const onEnd = () => {
        measureInsets();
        removeSashMoveListeners?.();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
      removeSashMoveListeners = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
        removeSashMoveListeners = null;
      };
    };
    document.addEventListener('pointerdown', handlePointerDownCapture, true);

    return () => {
      document.removeEventListener(
        'pointerdown',
        handlePointerDownCapture,
        true
      );
      removeSashMoveListeners?.();
      for (const disp of apiDisposables) {
        disp?.dispose();
      }
      clearGroupObservers();
    };
  }, [
    apiRef,
    arrangement,
    dockviewRootRef,
    enabled,
    isDockviewMounted,
    readyDockviewApi,
    serializedLayout,
  ]);

  return stageInsets;
}
