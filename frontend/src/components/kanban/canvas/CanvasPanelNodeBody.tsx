import { memo, useEffect, useMemo, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { useSessionCanvasView } from './CanvasViewContext';

export interface CanvasPanelNodeBodyProps {
  instanceId: string;
  panelId: string;
  panelComponent: string;
  panelTitle: string;
  panelParams?: Record<string, unknown>;
  selected?: boolean;
}

function createNoopDisposable() {
  return { dispose: () => {} };
}

export const CanvasPanelNodeBody = memo(function CanvasPanelNodeBody({
  instanceId,
  panelId,
  panelComponent,
  panelTitle,
  panelParams,
  selected = false,
}: CanvasPanelNodeBodyProps) {
  const { removeCard, updatePanelNodeMeta } = useSessionCanvasView();
  const titleRef = useRef(panelTitle);
  titleRef.current = panelTitle;
  const paramsRef = useRef(panelParams ?? {});
  paramsRef.current = panelParams ?? {};
  const removeCardRef = useRef(removeCard);
  removeCardRef.current = removeCard;
  const updateMetaRef = useRef(updatePanelNodeMeta);
  updateMetaRef.current = updatePanelNodeMeta;

  const titleListenersRef = useRef(new Set<(event: { title: string }) => void>());
  const paramListenersRef = useRef(
    new Set<(params: Record<string, unknown>) => void>()
  );

  useEffect(() => {
    for (const listener of titleListenersRef.current) {
      listener({ title: panelTitle });
    }
  }, [panelTitle]);

  useEffect(() => {
    for (const listener of paramListenersRef.current) {
      listener(panelParams ?? {});
    }
  }, [panelParams]);

  const mockDockviewProps = useMemo<IDockviewPanelProps>(() => {
    const api = {
      id: panelId || instanceId,
      component: panelComponent,
      get title() {
        return titleRef.current;
      },
      isVisible: true,
      isActive: selected,
      group: {
        id: 'editor-group-1',
        panels: [],
      },
      close: () => {
        removeCardRef.current(instanceId);
      },
      setActive: () => {},
      setTitle: (nextTitle: string) => {
        titleRef.current = nextTitle;
        updateMetaRef.current?.(instanceId, { title: nextTitle });
        for (const listener of titleListenersRef.current) {
          listener({ title: nextTitle });
        }
      },
      updateParameters: (nextParams: Record<string, unknown>) => {
        const merged = { ...paramsRef.current, ...nextParams };
        paramsRef.current = merged;
        updateMetaRef.current?.(instanceId, { params: merged });
        for (const listener of paramListenersRef.current) {
          listener(merged);
        }
      },
      onDidVisibilityChange: () => createNoopDisposable(),
      onDidActiveChange: () => createNoopDisposable(),
      onDidDimensionsChange: () => createNoopDisposable(),
      onDidFocusChange: () => createNoopDisposable(),
      onDidLocationChange: () => createNoopDisposable(),
      onDidGroupChange: () => createNoopDisposable(),
      onDidTitleChange: (listener: (event: { title: string }) => void) => {
        titleListenersRef.current.add(listener);
        return {
          dispose: () => {
            titleListenersRef.current.delete(listener);
          },
        };
      },
      onDidParametersChange: (
        listener: (params: Record<string, unknown>) => void
      ) => {
        paramListenersRef.current.add(listener);
        return {
          dispose: () => {
            paramListenersRef.current.delete(listener);
          },
        };
      },
    };

    const containerApi = {
      id: 'canvas-container',
      groups: [],
      panels: [],
      getPanel: () => undefined,
      getGroup: () => undefined,
      addPanel: () => undefined,
      addGroup: () => undefined,
    };

    return {
      api: api as unknown as IDockviewPanelProps['api'],
      containerApi:
        containerApi as unknown as IDockviewPanelProps['containerApi'],
      params: panelParams ?? {},
    };
  }, [instanceId, panelComponent, panelId, panelParams, selected]);

  const PanelComponent = panelComponents[panelComponent];

  if (!PanelComponent) {
    return (
      <div
        className="flex h-full w-full items-center justify-center p-4 text-xs text-muted-foreground"
        data-testid={`canvas-panel-placeholder-${panelComponent}`}
      >
        {panelTitle || panelComponent}
      </div>
    );
  }

  return (
    <div
      className="h-full w-full overflow-hidden"
      data-testid={`canvas-panel-body-${panelComponent}`}
    >
      <PanelComponent {...mockDockviewProps} />
    </div>
  );
});
