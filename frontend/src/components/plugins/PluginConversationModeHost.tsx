import {
  type ConversationModeContribution,
  useConversationModes,
} from '@vibex/plugin-sdk';
import { MessageSquare, Puzzle } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { cn } from '@/lib/utils';

let activeModeIdState: string | null = null;
const modeListeners = new Set<() => void>();

function subscribeActiveMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

function getActiveModeSnapshot(): string | null {
  return activeModeIdState;
}

export function setActivePluginConversationMode(modeId: string | null): void {
  if (activeModeIdState === modeId) return;
  activeModeIdState = modeId;
  for (const listener of Array.from(modeListeners)) {
    listener();
  }
}

export function useActivePluginConversationMode(): {
  readonly activeModeId: string | null;
  readonly activeMode: ConversationModeContribution | null;
  readonly modes: readonly ConversationModeContribution[];
  readonly setActiveModeId: (modeId: string | null) => void;
} {
  const modes = useConversationModes();
  const rawActiveId = useSyncExternalStore(
    subscribeActiveMode,
    getActiveModeSnapshot,
    getActiveModeSnapshot
  );

  const activeMode = useMemo(
    () =>
      rawActiveId
        ? (modes.find((mode) => mode.id === rawActiveId) ?? null)
        : null,
    [modes, rawActiveId]
  );

  useEffect(() => {
    if (rawActiveId && !activeMode) {
      setActivePluginConversationMode(null);
    }
  }, [activeMode, rawActiveId]);

  const selectMode = useCallback(
    (modeId: string | null) => {
      setActivePluginConversationMode(modeId);
      if (modeId) {
        const target = modes.find((m) => m.id === modeId);
        if (target?.onActivate) {
          void Promise.resolve(target.onActivate()).catch(() => undefined);
        }
      }
    },
    [modes]
  );

  return {
    activeModeId: activeMode ? activeMode.id : null,
    activeMode,
    modes,
    setActiveModeId: selectMode,
  };
}

export function PluginConversationModeSwitcher({
  className,
}: {
  readonly className?: string;
}) {
  const { activeModeId, modes, setActiveModeId } =
    useActivePluginConversationMode();

  if (modes.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-xs',
        className
      )}
      data-testid="plugin-conversation-mode-switcher"
    >
      <button
        type="button"
        onClick={() => setActiveModeId(null)}
        data-active={activeModeId === null}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded px-2 font-medium transition-colors',
          activeModeId === null
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <MessageSquare className="h-3 w-3" />
        <span>Chat</span>
      </button>
      {modes.map((mode) => {
        const Icon = contributionIconComponent(mode.icon, Puzzle);
        const isActive = activeModeId === mode.id;
        return (
          <button
            key={`${mode.pluginId ?? 'plugin'}:${mode.id}`}
            type="button"
            onClick={() => setActiveModeId(isActive ? null : mode.id)}
            data-active={isActive}
            title={mode.description ?? mode.label}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded px-2 font-medium transition-colors',
              isActive
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3 w-3" />
            <span>{mode.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function PluginConversationModeTakeover({
  mode,
  workspaceId,
  sessionId,
  taskId,
  onExitMode,
}: {
  readonly mode: ConversationModeContribution;
  readonly workspaceId?: string | null;
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly onExitMode?: () => void;
}) {
  const pluginId = mode.pluginId ?? 'unknown-plugin';
  const Component = mode.component;
  const props = {
    pluginId,
    modeId: mode.id,
    workspaceId: workspaceId ?? null,
    sessionId: sessionId ?? null,
    taskId: taskId ?? null,
    onExitMode: onExitMode ?? (() => setActivePluginConversationMode(null)),
  };

  return (
    <PluginBoundary pluginId={pluginId} slot="composer.mode">
      <div
        className="flex h-full min-h-0 w-full flex-1 flex-col overflow-auto"
        data-testid={`plugin-conversation-mode-view-${mode.id}`}
      >
        {Component ? (
          <Component {...props} />
        ) : mode.render ? (
          (mode.render(props) as ReactNode)
        ) : null}
      </div>
    </PluginBoundary>
  );
}
