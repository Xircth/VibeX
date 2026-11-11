import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanNavArrow } from '@/components/kanban/KanbanNavArrow';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useKanbanViewContributions } from '@vibex/plugin-sdk';
import { useKanbanViews } from '@/hooks/useKanbanViews';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import {
  consumeKanbanCarouselPageKey,
  pinKanbanCarouselScroll,
} from '@/lib/kanbanCarouselScroll';
import {
  adjacentKanbanViewId,
  kanbanCarouselTranslateX,
  kanbanCarouselWidth,
  kanbanPageWidth,
  kanbanViewHidesSessionSlot,
  kanbanViewIndex,
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

const LazyKanbanUsageDashboard = lazy(() =>
  import('@/components/kanban/KanbanUsageDashboard').then((module) => ({
    default: module.KanbanUsageDashboard,
  }))
);

const KANBAN_CAROUSEL_TRANSITION_MS = 320;

export function KanbanBoard() {
  const { t } = useTranslation(['panels', 'common']);
  const { activeViewId, setActiveViewId } = useKanbanSessionContext();
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
  const previousViewIdRef = useRef(currentViewId);
  const [transitioningFromViewId, setTransitioningFromViewId] = useState<
    string | null
  >(null);

  useEffect(() => {
    const previousViewId = previousViewIdRef.current;
    if (previousViewId && previousViewId !== currentViewId) {
      previousViewIdRef.current = currentViewId;
      setTransitioningFromViewId(previousViewId);
      const timer = window.setTimeout(() => {
        setTransitioningFromViewId((current) =>
          current === previousViewId ? null : current
        );
      }, KANBAN_CAROUSEL_TRANSITION_MS);
      return () => window.clearTimeout(timer);
    }
    previousViewIdRef.current = currentViewId;
    return undefined;
  }, [currentViewId]);

  const currentIndex = kanbanViewIndex(views, currentViewId);
  const sessionSlotSide = kanbanSlotOfZone(kanbanArrangement, 'session');
  const hideSessionSlot = kanbanViewHidesSessionSlot(currentViewId);
  const sessionInHub = kanbanSessionRendersInHub(currentViewId);
  const outerSessionSide: 'left' | 'right' =
    sessionSlotSide === 'left' ? 'left' : 'right';
  const outerSessionActive = !hideSessionSlot && !sessionInHub;

  const showLeftArrow = currentIndex > 0;
  const showRightArrow = currentIndex < views.length - 1;
  const carouselShellRef = useRef<HTMLDivElement | null>(null);

  const handleLeftArrowClick = () => {
    setActiveViewId(adjacentKanbanViewId(views, currentViewId, -1));
  };

  const handleRightArrowClick = () => {
    setActiveViewId(adjacentKanbanViewId(views, currentViewId, 1));
  };

  useLayoutEffect(() => {
    pinKanbanCarouselScroll(carouselShellRef.current);
  }, [currentViewId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      consumeKanbanCarouselPageKey(event, carouselShellRef.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const getLeftArrowLabel = () => {
    const previous = views[currentIndex - 1];
    return previous
      ? t(previous.titleKey, { defaultValue: previous.titleKey })
      : '';
  };

  const getRightArrowLabel = () => {
    const next = views[currentIndex + 1];
    return next ? t(next.titleKey, { defaultValue: next.titleKey }) : '';
  };

  return (
    <div className="relative flex h-full w-full" data-panel="kanban">
      {!hideSessionSlot && outerSessionSide === 'left' && (
        <KanbanSessionSlot side="left" active={outerSessionActive} />
      )}
      <div
        ref={carouselShellRef}
        className="kanban-shell relative h-full min-w-0 flex-1"
        onScroll={() => pinKanbanCarouselScroll(carouselShellRef.current)}
        onKeyDownCapture={(event) => {
          consumeKanbanCarouselPageKey(event, event.currentTarget);
        }}
      >
        <div
          className="flex h-full transition-transform duration-300 ease-out"
          style={{
            width: kanbanCarouselWidth(views.length),
            transform: kanbanCarouselTranslateX(views, currentViewId),
          }}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) {
              setTransitioningFromViewId(null);
            }
          }}
        >
          {views.map((view) => {
            const isMountedView =
              view.id === currentViewId || view.id === transitioningFromViewId;

            return (
              <div
                key={view.id}
                className="h-full shrink-0"
                style={{ width: kanbanPageWidth(views.length) }}
                data-kanban-view={view.id}
              >
                {isMountedView ? (
                  <KanbanViewErrorBoundary>
                    <KanbanRegisteredView
                      view={view}
                      active={view.id === currentViewId}
                      zoneOrder={[
                        kanbanArrangement.left,
                        kanbanArrangement.center,
                        kanbanArrangement.right,
                      ]}
                      sessionSlot={
                        view.id === 'builtin:sessions' ? (
                          <KanbanSessionSlot
                            side={sessionSlotSide}
                            active={currentViewId === 'builtin:sessions'}
                            inHub
                          />
                        ) : null
                      }
                      pluginItem={
                        view.pluginId
                          ? (pluginViews.find(
                              (item) =>
                                item.pluginId === view.pluginId &&
                                item.id === view.contributionId
                            ) ??
                            (() => {
                              const sdkMatch = sdkKanbanViews.find(
                                (item) =>
                                  item.pluginId === view.pluginId &&
                                  (item.id === view.contributionId ||
                                    item.id ===
                                      `${view.pluginId}:${view.contributionId}`)
                              );
                              if (!sdkMatch || !view.contributionId) {
                                return null;
                              }
                              return {
                                pluginId: view.pluginId,
                                id: view.contributionId,
                                kind: 'kanban_view' as const,
                                label: sdkMatch.title,
                                generation: 1,
                                metadata: {
                                  hidesBottomDock:
                                    sdkMatch.hidesBottomDock !== false,
                                },
                              };
                            })())
                          : null
                      }
                    />
                  </KanbanViewErrorBoundary>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {!hideSessionSlot && outerSessionSide === 'right' && (
        <KanbanSessionSlot side="right" active={outerSessionActive} />
      )}
      {showLeftArrow && (
        <KanbanNavArrow
          side="left"
          label={getLeftArrowLabel()}
          onClick={handleLeftArrowClick}
        />
      )}
      {showRightArrow && (
        <KanbanNavArrow
          side="right"
          label={getRightArrowLabel()}
          onClick={handleRightArrowClick}
        />
      )}
    </div>
  );
}

class KanbanViewErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <PluginSurfacePlaceholder
          reason="failed"
          onRecover={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}

function KanbanRegisteredView({
  view,
  active,
  zoneOrder,
  sessionSlot,
  pluginItem,
}: {
  view: { id: string; pluginId?: string };
  active: boolean;
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
    return (
      <Suspense fallback={null}>
        <LazyKanbanUsageDashboard />
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
