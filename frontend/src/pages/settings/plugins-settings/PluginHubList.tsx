import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Puzzle,
  Search,
} from 'lucide-react';
import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import type { BackendTransport } from '@/lib/backendTransport';
import type { PluginControlItem } from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import {
  PLUGIN_LIST_PANE_MAX,
  PLUGIN_LIST_PANE_MIN,
  PLUGIN_LIST_PANE_STORAGE_KEY,
  PLUGIN_TABS,
  clampPluginListPane,
  initialPluginListPanePercent,
  type PluginEcosystem,
} from './pluginConstants';

export function PluginHubList({
  transport,
  canWrite,
  queries,
  setQueries,
  effectiveTab,
  error,
  reload,
  isLoading,
  visiblePlugins,
  selected,
  setSelectedId,
  children,
}: {
  transport: BackendTransport;
  canWrite: boolean;
  queries: Record<PluginEcosystem, string>;
  setQueries: Dispatch<SetStateAction<Record<PluginEcosystem, string>>>;
  effectiveTab: PluginEcosystem;
  error: string | null;
  reload: () => Promise<void>;
  isLoading: boolean;
  visiblePlugins: PluginControlItem[];
  selected: PluginControlItem | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  children: ReactNode;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [listPanePercent, setListPanePercent] = useState(
    initialPluginListPanePercent
  );
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const pluginGridRef = useRef<HTMLDivElement>(null);
  const resizingPanelsRef = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PLUGIN_LIST_PANE_STORAGE_KEY,
        String(listPanePercent)
      );
    } catch {
      // The setting is optional when persistent storage is unavailable.
    }
  }, [listPanePercent]);

  const resizePanelsFromClientX = (clientX: number) => {
    const bounds = pluginGridRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    setListPanePercent(
      clampPluginListPane(
        Math.round(((clientX - bounds.left) / bounds.width) * 100)
      )
    );
  };

  const beginPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    resizingPanelsRef.current = true;
    setIsResizingPanels(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizePanelsFromClientX(event.clientX);
  };

  const continuePanelResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizingPanelsRef.current) return;
    resizePanelsFromClientX(event.clientX);
  };

  const finishPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    resizingPanelsRef.current = false;
    setIsResizingPanels(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const resizePanelsFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = listPanePercent;
    if (event.key === 'ArrowLeft') next -= 2;
    else if (event.key === 'ArrowRight') next += 2;
    else if (event.key === 'Home') next = PLUGIN_LIST_PANE_MIN;
    else if (event.key === 'End') next = PLUGIN_LIST_PANE_MAX;
    else return;
    event.preventDefault();
    setListPanePercent(clampPluginListPane(next));
  };

  return (
    <>
      {transport.environment !== 'desktop' && !canWrite ? (
        <p className="plugin-detail-empty-copy" role="status">
          {t('plugins.remoteReadOnly')}
        </p>
      ) : null}
      <div className="plugin-hub-toolbar">
        <label className="plugin-search-control">
          <Search aria-hidden="true" />
          <span className="sr-only">
            {t('plugins.searchInTab', {
              tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
            })}
          </span>
          <input
            type="search"
            value={queries[effectiveTab]}
            onChange={(event) =>
              setQueries((current) => ({
                ...current,
                [effectiveTab]: event.target.value,
              }))
            }
            placeholder={t('plugins.searchPlaceholderInTab', {
              tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
            })}
            aria-label={t('plugins.searchInTab', {
              tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
            })}
          />
        </label>
      </div>

      {error ? (
        <div role="alert" className="plugin-hub-error">
          <AlertTriangle aria-hidden="true" />
          <span>{t('plugins.operationFailed', { error })}</span>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            {t('common:retry')}
          </Button>
        </div>
      ) : null}

      <div className="plugin-hub-frame">
        {isLoading ? (
          <div role="status" className="plugin-hub-loading">
            <Loader2 className="animate-spin" />
            {t('plugins.loading')}
          </div>
        ) : visiblePlugins.length ? (
          <div
            ref={pluginGridRef}
            className={cn('plugin-hub-grid', isResizingPanels && 'is-resizing')}
            style={
              {
                '--plugin-list-width': `${listPanePercent}%`,
              } as CSSProperties
            }
          >
            <nav
              className="plugin-hub-list"
              aria-label={t('plugins.catalogAria')}
            >
              {visiblePlugins.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  className={cn(
                    'plugin-hub-row',
                    selected?.id === plugin.id && 'is-selected'
                  )}
                  onClick={() => setSelectedId(plugin.id)}
                  aria-current={selected?.id === plugin.id ? 'true' : undefined}
                  aria-label={`${plugin.name} · ${plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}`}
                >
                  <span className="min-w-0 flex-1 text-left">
                    <strong>{plugin.name}</strong>
                  </span>
                  <span
                    className={cn(
                      'plugin-state-dot',
                      plugin.enabled && 'is-enabled'
                    )}
                    aria-hidden="true"
                  />
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              ))}
            </nav>
            <div
              className="workspace-resize-handle plugin-hub-resizer"
              role="separator"
              tabIndex={0}
              aria-label={t('plugins.resizePanelsAria')}
              aria-orientation="vertical"
              aria-valuemin={PLUGIN_LIST_PANE_MIN}
              aria-valuemax={PLUGIN_LIST_PANE_MAX}
              aria-valuenow={listPanePercent}
              aria-valuetext={t('plugins.resizePanelsValue', {
                percent: listPanePercent,
              })}
              onPointerDown={beginPanelResize}
              onPointerMove={continuePanelResize}
              onPointerUp={finishPanelResize}
              onPointerCancel={finishPanelResize}
              onLostPointerCapture={() => {
                resizingPanelsRef.current = false;
                setIsResizingPanels(false);
              }}
              onKeyDown={resizePanelsFromKeyboard}
            />
            {children}
          </div>
        ) : (
          <div className="plugin-hub-empty">
            <Puzzle aria-hidden="true" />
            <strong>{t('plugins.emptyTitle')}</strong>
            <p>
              {t('plugins.emptyDescriptionInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
              })}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
