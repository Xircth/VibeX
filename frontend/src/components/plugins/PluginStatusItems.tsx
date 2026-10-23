import { useSlotContributions, useViews } from '@vibex/plugin-sdk';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { Slot } from '@/components/plugins/Slot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  createPluginControlApi,
  type PluginContributionCatalogItem,
} from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import { useBackendTransport } from '@/lib/transport';

/** Items past this point move into the overflow menu rather than being dropped. */
const INLINE_LIMIT = 3;

interface StatusEntry {
  key: string;
  item: PluginContributionCatalogItem;
  pluginId: string;
  handler: string;
  icon: ReturnType<typeof contributionIconComponent>;
  text: string;
  tooltip?: string;
  refreshSeconds?: number;
  hasPopoverView: boolean;
  onActivate?: () => void | Promise<void>;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readStatusResult(result: unknown): {
  text?: string;
  tooltip?: string;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const record = result as Record<string, unknown>;
  return {
    text: typeof record.text === 'string' ? record.text : undefined,
    tooltip: typeof record.tooltip === 'string' ? record.tooltip : undefined,
  };
}

/**
 * Plugin-contributed status bar items. Plugins may add items here; they cannot
 * change or remove the Host's own indicators, which render alongside.
 */
export function PluginStatusItems({
  placement = 'main',
}: {
  /** `after-mcp` renders icon buttons immediately right of the MCP status icon. */
  placement?: 'main' | 'after-mcp';
}) {
  const { t } = useTranslation('common');
  const contributions = usePluginHostContributions('status');
  const slotName =
    placement === 'after-mcp' ? 'status.after-mcp' : 'status.bar';
  const slotItems = useSlotContributions(slotName);
  const registeredViews = useViews();
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [live, setLive] = useState<
    Record<string, { text?: string; tooltip?: string }>
  >({});

  const entries = useMemo<StatusEntry[]>(() => {
    const seen = new Set<string>();
    const result: StatusEntry[] = [];

    for (const slotItem of slotItems) {
      if (slotItem.component || slotItem.render) continue;
      const pluginId = slotItem.pluginId ?? 'plugin';
      const key = `${pluginId}:${slotItem.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = live[key]?.text ?? slotItem.label ?? slotItem.id;
      result.push({
        key,
        item: {
          pluginId,
          id: slotItem.id,
          kind: 'status',
          label: text,
          generation: 1,
          metadata: slotItem.metadata ?? {},
        },
        pluginId,
        handler: slotItem.id,
        icon: contributionIconComponent(slotItem.icon),
        text,
        tooltip: live[key]?.tooltip ?? slotItem.tooltip,
        hasPopoverView: registeredViews.some(
          (view) => view.pluginId === pluginId && view.id === slotItem.id
        ),
        onActivate: slotItem.onActivate
          ? () => slotItem.onActivate?.()
          : undefined,
      });
    }

    for (const item of contributions) {
      const metadata = contributionMetadata(item);
      const slot =
        typeof metadata.slot === 'string' ? metadata.slot : 'status.main';
      const afterMcp = slot === 'status.after-mcp';
      if (placement === 'after-mcp' ? !afterMcp : afterMcp) continue;
      const key = `${item.pluginId}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        key,
        item,
        pluginId: item.pluginId,
        handler:
          typeof metadata.handler === 'string' ? metadata.handler : item.id,
        icon: contributionIconComponent(metadata.icon),
        text:
          live[key]?.text ??
          (typeof metadata.text === 'string' ? metadata.text : item.label),
        tooltip:
          live[key]?.tooltip ??
          (typeof metadata.tooltip === 'string' ? metadata.tooltip : undefined),
        refreshSeconds: positiveInteger(metadata.refreshSeconds),
        hasPopoverView: registeredViews.some(
          (view) => view.pluginId === item.pluginId && view.id === item.id
        ),
      });
    }

    return result;
  }, [contributions, live, placement, registeredViews, slotItems]);

  const refreshTargets = useMemo(
    () =>
      entries
        .filter((entry) => entry.refreshSeconds !== undefined)
        .map((entry) => ({
          key: entry.key,
          pluginId: entry.pluginId,
          handler: entry.handler,
          seconds: entry.refreshSeconds as number,
        })),
    [entries]
  );
  // The effect below writes the text that `entries` — and therefore
  // `refreshTargets` — is derived from, so depending on the array directly
  // would restart every timer on each tick. It reads the current targets
  // through a ref and restarts only when the set of timers actually changes.
  const refreshTargetsRef = useRef(refreshTargets);
  refreshTargetsRef.current = refreshTargets;
  const refreshSignature = refreshTargets
    .map((target) => `${target.key}@${target.seconds}`)
    .join('|');

  useEffect(() => {
    const targets = refreshTargetsRef.current;
    if (targets.length === 0) return;
    let disposed = false;
    const isDocumentHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async (target: (typeof targets)[number]) => {
      if (isDocumentHidden()) return;
      try {
        const result = await api.invokeContribution(
          target.pluginId,
          target.handler
        );
        if (disposed) return;
        const next = readStatusResult(result);
        if (next.text === undefined && next.tooltip === undefined) return;
        setLive((current) => ({ ...current, [target.key]: next }));
      } catch {
        // A failing refresh leaves the last known text in place; the plugin
        // diagnostics panel carries the evidence.
      }
    };
    const timers = targets.map((target) => {
      void tick(target);
      return window.setInterval(() => void tick(target), target.seconds * 1000);
    });
    const handleVisibilityChange = () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        for (const target of targets) {
          void tick(target);
        }
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    return () => {
      disposed = true;
      timers.forEach(window.clearInterval);
      if (typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange
        );
      }
    };
  }, [api, refreshSignature]);

  const invoke = useCallback(
    (entry: StatusEntry) => {
      if (entry.onActivate) {
        void Promise.resolve(entry.onActivate())
          .then((result) => {
            const next = readStatusResult(result);
            if (next.text === undefined && next.tooltip === undefined) return;
            setLive((current) => ({ ...current, [entry.key]: next }));
          })
          .catch(() => undefined);
        return;
      }
      void api
        .invokeContribution(entry.pluginId, entry.handler)
        .then((result) => {
          const next = readStatusResult(result);
          if (next.text === undefined && next.tooltip === undefined) return;
          setLive((current) => ({ ...current, [entry.key]: next }));
        })
        .catch(() => undefined);
    },
    [api]
  );

  const hasCustomSlotComponents = useMemo(
    () => slotItems.some((item) => Boolean(item.component || item.render)),
    [slotItems]
  );

  if (entries.length === 0 && !hasCustomSlotComponents) return null;

  if (placement === 'after-mcp') {
    return (
      <>
        {hasCustomSlotComponents ? <Slot name="status.after-mcp" /> : null}
        {entries.map((entry) => (
          <AfterMcpStatusButton
            key={entry.key}
            entry={entry}
            onInvoke={() => invoke(entry)}
          />
        ))}
      </>
    );
  }

  const inline = entries.slice(0, INLINE_LIMIT);
  const overflow = entries.slice(INLINE_LIMIT);

  return (
    <>
      {hasCustomSlotComponents ? <Slot name="status.bar" /> : null}
      {inline.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.key}
            type="button"
            title={entry.tooltip ?? entry.text}
            className={cn(
              'flex max-w-[10rem] items-center gap-1 truncate rounded-sm px-1 text-[11px] text-secondary-foreground',
              'hover:bg-accent/70'
            )}
            onClick={() => invoke(entry)}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate">{entry.text}</span>
          </button>
        );
      })}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('more')}
              className="flex h-4 w-4 items-center justify-center rounded-sm opacity-80 hover:bg-accent/70 hover:opacity-100"
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflow.map((entry) => {
              const Icon = entry.icon;
              return (
                <DropdownMenuItem
                  key={entry.key}
                  onSelect={() => invoke(entry)}
                  className="gap-2"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate">{entry.text}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function AfterMcpStatusButton({
  entry,
  onInvoke,
}: {
  entry: StatusEntry;
  onInvoke: () => void;
}) {
  const Icon = entry.icon;
  const label = entry.tooltip ?? entry.text;
  const buttonClass =
    'flex h-4 w-4 items-center justify-center rounded-sm text-secondary-foreground hover:bg-accent/70';
  if (!entry.hasPopoverView) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={buttonClass}
        onClick={onInvoke}
      >
        <Icon className="h-3 w-3" />
      </button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={buttonClass}
        >
          <Icon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="flex h-[min(78vh,620px)] w-[min(720px,calc(100vw-2rem))] flex-col overflow-hidden border border-border bg-background p-0 shadow-md"
      >
        <PluginRemoteView item={entry.item} slot="status.after-mcp" />
      </PopoverContent>
    </Popover>
  );
}
