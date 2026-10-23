import React, {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { type IDockviewPanelProps } from 'dockview-react';
import {
  type Disposer,
  panelRegistry,
  type PanelContribution,
  type VibeXPluginContext,
} from '@vibex/plugin-sdk';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { PANEL_IDS, type PanelId } from '@/stores/useLayoutStore';

export { WorkspaceDockviewTab } from './WorkspaceDockviewTab';

type DockviewPanelModule = {
  default: ComponentType<IDockviewPanelProps>;
};

function WorkspacePanelFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader size={24} />
    </div>
  );
}

function WorkspacePanelLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation(['panels', 'common']);
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3"
      data-testid="dockview-panel-load-error"
    >
      <p className="text-sm text-muted-foreground">
        {t('panelRegistry.loadFailed')}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {t('panelRegistry.retry')}
      </Button>
    </div>
  );
}

class DockviewPanelErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[DockviewPanel] Failed to load panel:', error);
  }

  render() {
    if (this.state.hasError) {
      return <WorkspacePanelLoadError onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}

export function loadPanelModuleWithRetry(
  loader: () => Promise<DockviewPanelModule>,
  retryDelayMs = 200
): Promise<DockviewPanelModule> {
  return loader().catch(() => {
    if (retryDelayMs <= 0) {
      return loader();
    }
    return new Promise<DockviewPanelModule>((resolve, reject) => {
      window.setTimeout(() => {
        loader().then(resolve, reject);
      }, retryDelayMs);
    });
  });
}

export function createLazyDockviewPanel(
  loader: () => Promise<DockviewPanelModule>,
  retryDelayMs = 200
): React.FC<IDockviewPanelProps> {
  return function LazyDockviewPanel(props: IDockviewPanelProps) {
    const [generation, setGeneration] = useState(0);
    const [Panel, setPanel] = useState(() =>
      lazy(() => loadPanelModuleWithRetry(loader, retryDelayMs))
    );

    return (
      <DockviewPanelErrorBoundary
        key={generation}
        onRetry={() => {
          setPanel(() =>
            lazy(() => loadPanelModuleWithRetry(loader, retryDelayMs))
          );
          setGeneration((current) => current + 1);
        }}
      >
        <Suspense fallback={<WorkspacePanelFallback />}>
          <Panel {...props} />
        </Suspense>
      </DockviewPanelErrorBoundary>
    );
  };
}

function lazyPanel(
  loader: () => Promise<DockviewPanelModule>
): React.FC<IDockviewPanelProps> {
  return createLazyDockviewPanel(loader);
}

/** Registry mapping panel component IDs to their React components. */
const PANEL_COMPONENT_MAP: Record<PanelId, React.FC<IDockviewPanelProps>> = {
  [PANEL_IDS.KANBAN]: lazyPanel(
    () => import('@/components/panels/DockviewKanbanPanel')
  ),
  [PANEL_IDS.FILE_TREE]: lazyPanel(
    () => import('@/components/panels/DockviewFileTreePanel')
  ),
  [PANEL_IDS.PREVIEW]: lazyPanel(
    () => import('@/components/panels/DockviewPreviewPanel')
  ),
  [PANEL_IDS.DIFFS]: lazyPanel(
    () => import('@/components/panels/DockviewDiffsReviewPanel')
  ),
  [PANEL_IDS.TERMINAL]: lazyPanel(
    () => import('@/components/panels/DockviewTerminalPanel')
  ),
  [PANEL_IDS.AI_CHAT]: lazyPanel(
    () => import('@/components/panels/DockviewAIChatPanel')
  ),
  [PANEL_IDS.GIT]: lazyPanel(
    () => import('@/components/panels/DockviewGitPanel')
  ),
  [PANEL_IDS.MERGE]: lazyPanel(
    () => import('@/components/panels/DockviewMergePanel')
  ),
  [PANEL_IDS.WELCOME]: lazyPanel(
    () => import('@/components/panels/DockviewWelcomePanel')
  ),
  [PANEL_IDS.LOGS]: lazyPanel(
    () => import('@/components/panels/DockviewLogsPanel')
  ),
  [PANEL_IDS.NOTES]: lazyPanel(
    () => import('@/components/panels/DockviewNotesPanel')
  ),
  [PANEL_IDS.SESSION_DETAILS]: lazyPanel(
    () => import('@/components/panels/DockviewSessionDetailsPanel')
  ),
  [PANEL_IDS.PROCESSES]: lazyPanel(
    () => import('@/components/panels/DockviewProcessesPanel')
  ),
  [PANEL_IDS.SEARCH]: lazyPanel(
    () => import('@/components/panels/DockviewSearchPanel')
  ),
  [PANEL_IDS.SESSION_LIST]: lazyPanel(
    () =>
      import('@/components/workspace-session-list/WorkspaceSessionListPanel')
  ),
};

/**
 * The dockview component resolver.
 * Returns the appropriate panel component for the given component ID.
 */
export const PLUGIN_PANEL_COMPONENT = 'plugin-panel';

export const BUILTIN_PANEL_CONTRIBUTIONS: readonly PanelContribution[] = [
  {
    id: PANEL_IDS.KANBAN,
    title: 'Kanban',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.KANBAN],
  },
  {
    id: PANEL_IDS.FILE_TREE,
    title: 'File Explorer',
    zone: 'left',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.FILE_TREE],
  },
  {
    id: PANEL_IDS.PREVIEW,
    title: 'Preview',
    zone: 'editor',
    builtin: true,
    multiInstance: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.PREVIEW],
  },
  {
    id: PANEL_IDS.DIFFS,
    title: 'Diffs',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.DIFFS],
  },
  {
    id: PANEL_IDS.TERMINAL,
    title: 'Terminal',
    zone: 'bottom',
    builtin: true,
    multiInstance: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.TERMINAL],
  },
  {
    id: PANEL_IDS.AI_CHAT,
    title: 'AI Chat',
    zone: 'session',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.AI_CHAT],
  },
  {
    id: PANEL_IDS.GIT,
    title: 'Git',
    zone: 'left',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.GIT],
  },
  {
    id: PANEL_IDS.MERGE,
    title: 'Merge',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.MERGE],
  },
  {
    id: PANEL_IDS.WELCOME,
    title: 'Welcome',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.WELCOME],
  },
  {
    id: PANEL_IDS.LOGS,
    title: 'Logs',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.LOGS],
  },
  {
    id: PANEL_IDS.NOTES,
    title: 'Notes',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.NOTES],
  },
  {
    id: PANEL_IDS.SESSION_DETAILS,
    title: 'Session Details',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.SESSION_DETAILS],
  },
  {
    id: PANEL_IDS.PROCESSES,
    title: 'Processes',
    zone: 'editor',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.PROCESSES],
  },
  {
    id: PANEL_IDS.SEARCH,
    title: 'Search',
    zone: 'left',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.SEARCH],
  },
  {
    id: PANEL_IDS.SESSION_LIST,
    title: 'Session List',
    zone: 'left',
    builtin: true,
    component: PANEL_COMPONENT_MAP[PANEL_IDS.SESSION_LIST],
  },
];

export interface RegisterBuiltinPanelsOptions {
  readonly ctx?: VibeXPluginContext;
  readonly panelIds?: readonly string[];
  readonly pluginId?: string;
}

export function registerBuiltinPanels(
  options?: RegisterBuiltinPanelsOptions
): Disposer {
  const allowedIds = options?.panelIds ? new Set(options.panelIds) : null;
  const targetContributions = allowedIds
    ? BUILTIN_PANEL_CONTRIBUTIONS.filter((c) => allowedIds.has(c.id))
    : BUILTIN_PANEL_CONTRIBUTIONS;
  const disposers: Disposer[] = [];
  const ownerPluginId =
    options?.ctx?.pluginId ?? options?.pluginId ?? 'builtin';

  for (const contribution of targetContributions) {
    if (options?.ctx) {
      disposers.push(
        options.ctx.ui.registerPanel({
          ...contribution,
          builtin: true,
        })
      );
    } else {
      disposers.push(
        panelRegistry.register(
          { ...contribution, pluginId: ownerPluginId, builtin: true },
          ownerPluginId
        )
      );
    }
  }

  const cleanup: Disposer = () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      disposers[i]?.();
    }
  };

  if (options?.ctx) {
    options.ctx.effect(() => cleanup);
  }

  return cleanup;
}

const BASE_PANEL_COMPONENTS: Record<string, React.FC<IDockviewPanelProps>> = {
  ...PANEL_COMPONENT_MAP,
  [PLUGIN_PANEL_COMPONENT]: lazyPanel(
    () => import('@/components/layout/panels/PluginDockviewPanel')
  ),
};

const dynamicPanelWrappers = new Map<string, React.FC<IDockviewPanelProps>>();

function findPanelEntry(panelId: string): PanelContribution | undefined {
  const direct = panelRegistry.get(panelId);
  if (direct) return direct;
  if (panelId.startsWith('plugin:')) {
    const normalized = panelId.slice('plugin:'.length).replace('/', ':');
    return panelRegistry.get(normalized);
  }
  return undefined;
}

function getOrCreateDynamicPanelWrapper(
  panelId: string
): React.FC<IDockviewPanelProps> | undefined {
  const entry = findPanelEntry(panelId);
  if (!entry?.component) return undefined;
  let wrapper = dynamicPanelWrappers.get(panelId);
  if (!wrapper) {
    wrapper = function DynamicRegisteredPanel(props: IDockviewPanelProps) {
      const current = findPanelEntry(panelId);
      const Comp = current?.component as
        | React.ComponentType<IDockviewPanelProps>
        | undefined;
      if (!Comp) return null;
      return (
        <PluginBoundary
          pluginId={current?.pluginId ?? 'builtin'}
          slot={current?.title ?? panelId}
        >
          <Comp {...props} />
        </PluginBoundary>
      );
    };
    dynamicPanelWrappers.set(panelId, wrapper);
  }
  return wrapper;
}

export const panelComponents: Record<
  string,
  React.FC<IDockviewPanelProps>
> = new Proxy(BASE_PANEL_COMPONENTS, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    if (typeof prop === 'string') {
      const dynamic = getOrCreateDynamicPanelWrapper(prop);
      if (dynamic) return dynamic;
    }
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    if (typeof prop === 'string') {
      return prop in target || Boolean(findPanelEntry(prop)?.component);
    }
    return Reflect.has(target, prop);
  },
});

/**
 * Panel metadata for display purposes.
 */
export interface PanelMeta {
  id: PanelId;
  title: string;
  defaultPosition: 'left' | 'center' | 'bottom';
}

export function usePanelMeta(): PanelMeta[] {
  const { t } = useTranslation(['panels', 'common']);

  return [
    {
      id: PANEL_IDS.FILE_TREE,
      title: t('panelRegistry.fileExplorer'),
      defaultPosition: 'left',
    },
    { id: PANEL_IDS.KANBAN, title: 'Kanban', defaultPosition: 'center' },
    { id: PANEL_IDS.PREVIEW, title: 'Preview', defaultPosition: 'center' },
    { id: PANEL_IDS.DIFFS, title: 'Diffs', defaultPosition: 'center' },
    { id: PANEL_IDS.MERGE, title: 'Merge', defaultPosition: 'center' },
    { id: PANEL_IDS.TERMINAL, title: 'Terminal', defaultPosition: 'bottom' },
    {
      id: PANEL_IDS.GIT,
      title: t('panelRegistry.gitManager'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.WELCOME,
      title: t('panelRegistry.welcome'),
      defaultPosition: 'center',
    },
    { id: PANEL_IDS.LOGS, title: 'Logs', defaultPosition: 'center' },
    {
      id: PANEL_IDS.NOTES,
      title: t('panelRegistry.notes'),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.SESSION_DETAILS,
      title: t('panelRegistry.sessionDetails'),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.PROCESSES,
      title: t('panelRegistry.processes'),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.SEARCH,
      title: t('panelRegistry.search'),
      defaultPosition: 'left',
    },
    {
      id: PANEL_IDS.SESSION_LIST,
      title: t('panelRegistry.sessionList'),
      defaultPosition: 'left',
    },
  ];
}
