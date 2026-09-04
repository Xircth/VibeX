import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import { useBackendTransport } from '@/lib/transport';

/** Items past this point move into the overflow menu rather than being dropped. */
const INLINE_LIMIT = 3;

interface StatusEntry {
  key: string;
  pluginId: string;
  handler: string;
  icon: ReturnType<typeof contributionIconComponent>;
  text: string;
  tooltip?: string;
  refreshSeconds?: number;
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
export function PluginStatusItems() {
  const { t } = useTranslation('common');
  const contributions = usePluginHostContributions('status');
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [live, setLive] = useState<
    Record<string, { text?: string; tooltip?: string }>
  >({});

  const entries = useMemo<StatusEntry[]>(
    () =>
      contributions.map((item) => {
        const metadata = contributionMetadata(item);
        const key = `${item.pluginId}:${item.id}`;
        return {
          key,
          pluginId: item.pluginId,
          handler:
            typeof metadata.handler === 'string' ? metadata.handler : item.id,
          icon: contributionIconComponent(metadata.icon),
          text:
            live[key]?.text ??
            (typeof metadata.text === 'string' ? metadata.text : item.label),
          tooltip: live[key]?.tooltip,
          refreshSeconds: positiveInteger(metadata.refreshSeconds),
        };
      }),
    [contributions, live]
  );

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
    const tick = async (target: (typeof targets)[number]) => {
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
    return () => {
      disposed = true;
      timers.forEach(window.clearInterval);
    };
  }, [api, refreshSignature]);

  const invoke = useCallback(
    (entry: StatusEntry) => {
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

  if (entries.length === 0) return null;

  const inline = entries.slice(0, INLINE_LIMIT);
  const overflow = entries.slice(INLINE_LIMIT);

  return (
    <>
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
