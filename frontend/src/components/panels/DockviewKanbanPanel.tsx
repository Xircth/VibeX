import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useKanbanViewContributions } from '@dimoai/plugin-sdk';
import { useKanbanViews } from '@/hooks/useKanbanViews';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import {
  kanbanViewHidesSessionSlot,
  resolveKanbanViewId,
} from '@/lib/kanbanViews';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import {
  kanbanSlotOfZone,
  useKanbanArrangement,
} from '@/lib/layoutArrangement';
import { kanbanSessionRendersInHub } from '@/lib/kanbanZoneVisibility';
import { KanbanSessionHub } from '@/components/kanban/KanbanSessionHub';
import { KanbanSessionSlot } from '@/components/kanban/KanbanSessionSlot';
import { useOptionalProject } from '@/contexts/ProjectContext';
import {
  OPEN_PULSE_DECK_EVENT,
  OPEN_WORKFLOW_STUDIO_EVENT,
} from '@/components/kanban/pulseDeckEvents';

type LazyDefaultModule<P> = {
  default: ComponentType<P>;
};

function loadKanbanModuleWithRetry<P>(
  loader: () => Promise<LazyDefaultModule<P>>,
  retryDelayMs = 250
): Promise<LazyDefaultModule<P>> {
  return loader().catch(
    () =>
      new Promise<LazyDefaultModule<P>>((resolve, reject) => {
        window.setTimeout(() => {
          loader().then(resolve, reject);
        }, retryDelayMs);
      })
  );
}

function createRetryableLazyComponent<P extends object>(
  loader: () => Promise<LazyDefaultModule<P>>
) {
  let cached: LazyExoticComponent<ComponentType<P>> | null = null;
  const getComponent = () => {
    if (!cached) {
      const next = lazy(() =>
        loadKanbanModuleWithRetry(loader).catch((error) => {
          if (cached === next) {
            cached = null;
          }
          throw error;
        })
      );
      cached = next;
    }
    return cached;
  };
  const reset = () => {
    cached = null;
  };
  return { getComponent, reset };
}

const lazyKanbanUsageDashboardEntry = createRetryableLazyComponent<
  Record<string, never>
>(() =>
  import('@/components/kanban/KanbanUsageDashboard').then((module) => ({
    default: module.KanbanUsageDashboard,
  }))
);

const lazyPulseDeckViewEntry = createRetryableLazyComponent<{
  projectId?: string | null;
  className?: string;
}>(() =>
  import('@/components/kanban/PulseDeckView').then((module) => ({
    default: module.PulseDeckView,
  }))
);

function isActiveVisibleSurface(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element.closest('[aria-hidden="true"], [hidden], [inert]')) {
    return false;
  }
  return true;
}

export function KanbanBoard() {
  const optionalProject = useOptionalProject();
  const { activeViewId, setActiveViewId } = useKanbanSessionContext();
  const rootPanelRef = useRef<HTMLDivElement | null>(null);
  const kanbanArrangement = useKanbanArrangement();
  const views = useKanbanViews();
  const boardStyle = useKanbanBoardStyle();
  const pluginViews = usePluginHostContributions('kanban_view');
  const sdkKanbanViews = useKanbanViewContributions();
  const resolvedViewId = resolveKanbanViewId(activeViewId, views, boardStyle);
  useEffect(() => {
    if (resolvedViewId && resolvedViewId !== activeViewId) {
      setActiveViewId(resolvedViewId);
    }
  }, [activeViewId, resolvedViewId, setActiveViewId]);
  const currentViewId = resolvedViewId ?? activeViewId;
  const currentView =
    views.find((view) => view.id === currentViewId) ?? views[0] ?? null;

  useEffect(() => {
    const handleOpenPulseDeck = (event: Event) => {
      if (!isActiveVisibleSurface(rootPanelRef.current)) {
        return;
      }
      setActiveViewId('builtin:pulse');
      event.preventDefault();
    };
    const handleOpenWorkflowStudio = (event: Event) => {
      if (!isActiveVisibleSurface(rootPanelRef.current)) {
        return;
      }
      setActiveViewId('builtin:pulse');
      event.preventDefault();
    };
    window.addEventListener(OPEN_PULSE_DECK_EVENT, handleOpenPulseDeck);
    window.addEventListener(
      OPEN_WORKFLOW_STUDIO_EVENT,
      handleOpenWorkflowStudio
    );
    return () => {
      window.removeEventListener(OPEN_PULSE_DECK_EVENT, handleOpenPulseDeck);
      window.removeEventListener(
        OPEN_WORKFLOW_STUDIO_EVENT,
        handleOpenWorkflowStudio
      );
    };
  }, [setActiveViewId]);

  const sessionSlotSide = kanbanSlotOfZone(kanbanArrangement, 'session');
  const hideSessionSlot = kanbanViewHidesSessionSlot(currentViewId);
  const sessionInHub = kanbanSessionRendersInHub(currentViewId);
  const outerSessionSide: 'left' | 'right' =
    sessionSlotSide === 'left' ? 'left' : 'right';
  const outerSessionActive = !hideSessionSlot && !sessionInHub;

  const pluginItem = currentView?.pluginId
    ? (pluginViews.find(
        (item) =>
          item.pluginId === currentView.pluginId &&
          item.id === currentView.contributionId
      ) ??
      (() => {
        const sdkMatch = sdkKanbanViews.find(
          (item) =>
            item.pluginId === currentView.pluginId &&
            (item.id === currentView.contributionId ||
              item.id ===
                `${currentView.pluginId}:${currentView.contributionId}`)
        );
        if (!sdkMatch || !currentView.contributionId) {
          return null;
        }
        return {
          pluginId: currentView.pluginId,
          id: currentView.contributionId,
          kind: 'kanban_view' as const,
          label: sdkMatch.title,
          generation: 1,
          metadata: {
            hidesBottomDock: sdkMatch.hidesBottomDock !== false,
          },
        };
      })())
    : null;

  return (
    <div
      ref={rootPanelRef}
      className="relative flex h-full w-full flex-col"
      data-panel="kanban"
    >
      <div className="relative flex min-h-0 flex-1 w-full">
        {!hideSessionSlot && outerSessionSide === 'left' && (
          <KanbanSessionSlot side="left" active={outerSessionActive} />
        )}
        <div className="kanban-shell relative h-full min-w-0 flex-1">
          {currentView ? (
            <div
              key={currentView.id}
              className="h-full w-full"
              data-kanban-view={currentView.id}
            >
              <KanbanViewErrorBoundary>
                <KanbanRegisteredView
                  view={currentView}
                  active
                  projectId={optionalProject?.projectId ?? null}
                  zoneOrder={[
                    kanbanArrangement.left,
                    kanbanArrangement.center,
                    kanbanArrangement.right,
                  ]}
                  sessionSlot={
                    currentView.id === 'builtin:sessions' ? (
                      <KanbanSessionSlot side={sessionSlotSide} active inHub />
                    ) : null
                  }
                  pluginItem={pluginItem}
                />
              </KanbanViewErrorBoundary>
            </div>
          ) : null}
        </div>
        {!hideSessionSlot && outerSessionSide === 'right' && (
          <KanbanSessionSlot side="right" active={outerSessionActive} />
        )}
      </div>
    </div>
  );
}

class KanbanViewErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; retryKey: number }
> {
  state = { failed: false, retryKey: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[KanbanViewErrorBoundary] Failed to load view:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <PluginSurfacePlaceholder
          reason="failed"
          onRecover={() => {
            lazyKanbanUsageDashboardEntry.reset();
            lazyPulseDeckViewEntry.reset();
            this.setState((current) => ({
              failed: false,
              retryKey: current.retryKey + 1,
            }));
          }}
        />
      );
    }
    return (
      <div key={this.state.retryKey} className="h-full w-full">
        {this.props.children}
      </div>
    );
  }
}

function KanbanRegisteredView({
  view,
  active,
  projectId,
  zoneOrder,
  sessionSlot,
  pluginItem,
}: {
  view: { id: string; pluginId?: string };
  active: boolean;
  projectId: string | null;
  zoneOrder: Array<'list' | 'monitor' | 'session'>;
  sessionSlot: ReactNode;
  pluginItem: ReturnType<typeof usePluginHostContributions>[number] | null;
}) {
  if (view.id === 'builtin:sessions') {
    return (
      <KanbanSessionHub
        presentation="fixed"
        zoneOrder={zoneOrder}
        sessionSlot={sessionSlot}
      />
    );
  }
  if (view.id === 'builtin:canvas') {
    return <KanbanSessionHub presentation="canvas" zoneOrder={zoneOrder} />;
  }
  if (view.id === 'builtin:usage') {
    const LazyKanbanUsageDashboard =
      lazyKanbanUsageDashboardEntry.getComponent();
    return (
      <Suspense fallback={null}>
        <LazyKanbanUsageDashboard />
      </Suspense>
    );
  }
  if (view.id === 'builtin:pulse') {
    const LazyPulseDeckView = lazyPulseDeckViewEntry.getComponent();
    return (
      <Suspense fallback={null}>
        <LazyPulseDeckView projectId={projectId} className="h-full w-full" />
      </Suspense>
    );
  }
  return (
    <PluginRemoteView
      item={pluginItem}
      slot="app.kanban.view"
      enabled={active || pluginItem !== null}
    />
  );
}

function DockviewKanbanPanel() {
  return <KanbanBoard />;
}

export default DockviewKanbanPanel;
