import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Eye,
  History,
  MousePointerClick,
  ShieldOff,
  TriangleAlert,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';
import {
  getAgentActivity,
  subscribeBrowserChrome,
  type AgentActivityEntry,
} from './browserChromeStore';

const FIELD_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const ICON_SHARE_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';
const FIELD_PILL =
  'flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs';

const ACTIVITY_KEYS: Record<string, Record<string, string>> = {
  read: {
    done: 'browserPanel.activityReadDone',
    refused: 'browserPanel.activityReadRefused',
    failed: 'browserPanel.activityReadFailed',
  },
  click: {
    done: 'browserPanel.activityClickDone',
    refused: 'browserPanel.activityClickRefused',
    failed: 'browserPanel.activityClickFailed',
  },
  eval: {
    done: 'browserPanel.activityEvalDone',
    refused: 'browserPanel.activityEvalRefused',
    failed: 'browserPanel.activityEvalFailed',
  },
};

export function BrowserAgentShareControl({
  origin,
  grant,
  disabled,
  onShare,
}: {
  origin?: string | null;
  grant?: { level: string } | null;
  disabled?: boolean;
  onShare: (level: 'none' | 'read' | 'control') => void;
}) {
  const { t } = useTranslation('panels');
  const host = origin?.replace(/^https?:\/\//, '') || '';
  if (!grant) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={ICON_SHARE_BTN}
            title={host ? t('browserPanel.shareSite', { origin: host }) : t('browserPanel.share')}
            aria-label={t('browserPanel.share')}
            disabled={disabled || !origin}
          >
            <Bot className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[20000] min-w-56">
          <NativeSurfaceOcclusionHold />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {host ? t('browserPanel.shareSite', { origin: host }) : t('browserPanel.share')}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onShare('control')}>
            <MousePointerClick className="h-3.5 w-3.5" />
            {t('browserPanel.grantControl')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShare('read')}>
            <Eye className="h-3.5 w-3.5" />
            {t('browserPanel.grantRead')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const acting = grant.level === 'control';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            FIELD_PILL,
            'h-7 bg-blue-500/12 hover:bg-blue-500/20'
          )}
          title={t(acting ? 'browserPanel.sharedControl' : 'browserPanel.sharedRead')}
        >
          <span
            className={cn(
              'inline-flex min-w-0 items-center gap-1',
              !acting && 'browser-share-grant-read'
            )}
          >
            <Bot
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                acting && 'browser-share-grant-control-icon'
              )}
            />
            <span
              className={cn(
                'max-w-24 truncate',
                acting && 'composer-fast-model-flow'
              )}
            >
              {t(acting ? 'browserPanel.sharedControl' : 'browserPanel.sharedRead')}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[20000] min-w-56">
        <NativeSurfaceOcclusionHold />
        {acting ? (
          <DropdownMenuItem onSelect={() => onShare('read')}>
            <Eye className="h-3.5 w-3.5" />
            {t('browserPanel.grantRead')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onShare('control')}>
            <MousePointerClick className="h-3.5 w-3.5" />
            {t('browserPanel.grantControl')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onShare('none')}>
          <ShieldOff className="h-3.5 w-3.5" />
          {t('browserPanel.stopSharing')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BrowserAgentActivityControl({ tabId }: { tabId: string | null }) {
  const { t } = useTranslation('panels');
  const rows = useSyncExternalStore(
    subscribeBrowserChrome,
    () => getAgentActivity(tabId ?? ''),
    () => getAgentActivity('')
  );
  const latest = rows[0];
  if (!latest || !tabId) return null;
  const flagged = rows.find((entry) => entry.outcome !== 'done') ?? null;
  const shown = flagged ?? latest;
  const Glyph =
    flagged?.outcome === 'refused'
      ? ShieldOff
      : flagged
        ? TriangleAlert
        : History;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(FIELD_BTN, flagged && 'text-amber-600')}
          title={activityLabel(t, shown)}
          aria-label={activityLabel(t, shown)}
        >
          <Glyph className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[20000] w-80 max-w-[90vw] p-0">
        <NativeSurfaceOcclusionHold />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('browserPanel.activityTitle')}
        </div>
        <div className="max-h-64 overflow-y-auto border-t border-border/40 py-1">
          {rows.map((entry, index) => (
            <div
              key={`${entry.at}-${index}`}
              className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
            >
              {entry.outcome === 'refused' ? (
                <ShieldOff className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              ) : entry.outcome === 'failed' ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              ) : (
                <Bot className="h-3.5 w-3.5 shrink-0 text-violet-600" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {activityLabel(t, entry)}
                {entry.count > 1 ? ` ×${entry.count}` : ''}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {new Date(entry.at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function activityLabel(
  t: (key: string) => string,
  entry: AgentActivityEntry
): string {
  const key = ACTIVITY_KEYS[entry.action]?.[entry.outcome];
  return key ? t(key) : `${entry.action} · ${entry.outcome}`;
}
