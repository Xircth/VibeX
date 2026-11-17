import { useMemo } from 'react';
import { KeyRound, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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

const FIELD_BTN =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

export type BrowserBookmarkItem = {
  id: string;
  title: string;
  url: string;
  folder?: string;
  favicon?: string | null;
  createdAt?: number;
};

export type BrowserFrequentHistoryItem = {
  url: string;
  title: string;
  favicon?: string | null;
  visitCount: number;
  lastVisitedAt: number;
  source?: string;
};

export type BrowserCredentialSummary = {
  id: string;
  name: string;
  url: string;
  origin: string;
  username: string;
  source?: string;
  updatedAt?: number;
};

function canonicalHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function BrowserCredentialsButton({
  credentials,
  tabId,
  fillingId,
  onFill,
}: {
  credentials: readonly BrowserCredentialSummary[];
  tabId: string | null;
  fillingId: string | null;
  onFill: (credentialId: string) => void;
}) {
  const { t } = useTranslation('panels');
  if (!tabId || credentials.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            FIELD_BTN,
            'relative text-amber-600 hover:text-amber-500 dark:text-amber-400'
          )}
          title={t('browserPanel.autofill')}
          aria-label={t('browserPanel.autofill')}
        >
          <KeyRound className="h-3.5 w-3.5" />
          {credentials.length > 1 ? (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground tabular-nums">
              {credentials.length}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[20000] w-72 max-w-[90vw] p-0"
      >
        <NativeSurfaceOcclusionHold />
        <DropdownMenuLabel className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs font-medium">
          <span>{t('browserPanel.autofillHeader')}</span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {t('browserPanel.autofillLocalHint')}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-60 overflow-y-auto py-1">
          {credentials.map((cred) => (
            <DropdownMenuItem
              key={cred.id}
              disabled={fillingId === cred.id}
              onSelect={() => onFill(cred.id)}
              className="mx-1 flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {cred.username || t('browserPanel.autofillUnnamedAccount')}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {cred.name || cred.origin}
                </div>
              </div>
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {fillingId === cred.id
                  ? t('browserPanel.autofillFilling')
                  : t('browserPanel.autofillAction')}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BrowserBookmarksButton({
  currentUrl,
  bookmarks,
  onAddCurrent,
  onRemoveBookmark,
  onOpenUrl,
}: {
  currentUrl: string;
  bookmarks: readonly BrowserBookmarkItem[];
  onAddCurrent: () => void;
  onRemoveBookmark: (id?: string, url?: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation('panels');
  const normalizedCurrent = useMemo(
    () => canonicalHttpUrl(currentUrl),
    [currentUrl]
  );
  const matchedCurrent = useMemo(
    () =>
      normalizedCurrent
        ? bookmarks.find(
            (item) => canonicalHttpUrl(item.url) === normalizedCurrent
          ) ?? null
        : null,
    [bookmarks, normalizedCurrent]
  );
  const canToggleCurrent = Boolean(normalizedCurrent);
  const isBookmarked = Boolean(matchedCurrent);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            FIELD_BTN,
            isBookmarked && 'text-amber-500 hover:text-amber-400'
          )}
          title={t('browserPanel.bookmarks')}
          aria-label={t('browserPanel.bookmarks')}
          disabled={!canToggleCurrent && bookmarks.length === 0}
        >
          <Star
            className={cn('h-3.5 w-3.5', isBookmarked && 'fill-current')}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[20000] w-80 max-w-[90vw] p-0"
      >
        <NativeSurfaceOcclusionHold />
        {canToggleCurrent ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                if (matchedCurrent) {
                  onRemoveBookmark(matchedCurrent.id, matchedCurrent.url);
                } else {
                  onAddCurrent();
                }
              }}
              className="mx-1 my-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium"
            >
              <Star
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  isBookmarked
                    ? 'fill-amber-400 text-amber-500'
                    : 'text-muted-foreground'
                )}
              />
              <span>
                {isBookmarked
                  ? t('browserPanel.removeBookmark')
                  : t('browserPanel.addBookmark')}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-0" />
          </>
        ) : null}
        <DropdownMenuLabel className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-normal text-muted-foreground">
          <span>{t('browserPanel.bookmarks')}</span>
          <span className="tabular-nums">{bookmarks.length}</span>
        </DropdownMenuLabel>
        <div className="max-h-64 overflow-y-auto border-t border-border/40 py-1">
          {bookmarks.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('browserPanel.bookmarksEmpty')}
            </div>
          ) : (
            bookmarks.slice(0, 60).map((item) => (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => onOpenUrl(item.url)}
                className="group mx-1 flex items-center gap-2 rounded-md px-2 py-1.5"
              >
                {item.favicon ? (
                  <img
                    src={item.favicon}
                    alt=""
                    className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0 rounded-sm bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {item.title || item.url}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {item.folder ? `${item.folder} · ` : ''}
                    {item.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('browserPanel.deleteBookmark')}
                  title={t('browserPanel.deleteBookmark')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRemoveBookmark(item.id, item.url);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
