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
import { builtinPanelTitle } from '@/lib/builtinPanelTitles';
import {
  BUILTIN_PANEL_MANIFESTS,
  PANEL_ZONE_BY_POSITION,
  type BuiltinPanelManifestEntry,
} from '@/features/plugins/builtin-contributions';

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
const PANEL_COMPONENT_MAP: Record<
  PanelId,
  React.FC<IDockviewPanelProps>
> = Object.fromEntries(
  BUILTIN_PANEL_MANIFESTS.map((manifest) => [
    manifest.id,
    lazyPanel(manifest.component),
  ])
) as Record<PanelId, React.FC<IDockviewPanelProps>>;

/**
 * The dockview component resolver.
 * Returns the appropriate panel component for the given component ID.
 */
export const PLUGIN_PANEL_COMPONENT = 'plugin-panel';

/** One contribution per builtin panel manifest, in manifest order. */
function builtinPanelContribution(
  manifest: BuiltinPanelManifestEntry
): PanelContribution {
  return {
    id: manifest.id,
    get title() {
      return builtinPanelTitle(manifest.id);
    },
    zone: PANEL_ZONE_BY_POSITION[manifest.defaultPosition],
    builtin: true,
    ...(manifest.multiInstance ? { multiInstance: true } : {}),
    component: PANEL_COMPONENT_MAP[manifest.id],
  };
}

export const BUILTIN_PANEL_CONTRIBUTIONS: readonly PanelContribution[] =
  BUILTIN_PANEL_MANIFESTS.map(builtinPanelContribution);

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
    {
      id: PANEL_IDS.KANBAN,
      title: builtinPanelTitle(PANEL_IDS.KANBAN),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.PREVIEW,
      title: builtinPanelTitle(PANEL_IDS.PREVIEW),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.DIFFS,
      title: builtinPanelTitle(PANEL_IDS.DIFFS),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.MERGE,
      title: builtinPanelTitle(PANEL_IDS.MERGE),
      defaultPosition: 'center',
    },
    {
      id: PANEL_IDS.TERMINAL,
      title: builtinPanelTitle(PANEL_IDS.TERMINAL),
      defaultPosition: 'bottom',
    },
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
    {
      id: PANEL_IDS.LOGS,
      title: builtinPanelTitle(PANEL_IDS.LOGS),
      defaultPosition: 'center',
    },
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
