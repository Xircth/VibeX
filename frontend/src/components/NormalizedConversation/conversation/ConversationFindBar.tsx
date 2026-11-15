import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Globe,
  Loader2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  conversationApi,
  type ConversationGlobalSearchHit,
  type ConversationMatchSource,
} from '@/features/conversation/conversationApi';
import {
  recordPendingConversationJump,
  requestConversationScrollToQuote,
} from '@/lib/conversationScroll';
import { cn } from '@/lib/utils';

const GLOBAL_PAGE_SIZE = 20;

export interface ConversationFindBarProps {
  query: string;
  current: number;
  total: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  workspaceId?: string | null;
  currentConversationId?: string | null;
  defaultGlobalExpanded?: boolean;
  searchGlobal?: (params: {
    query: string;
    workspaceId?: string | null;
    limit: number;
    offset: number;
  }) => Promise<ConversationGlobalSearchHit[]>;
  onSelectGlobalHit?: (hit: ConversationGlobalSearchHit) => void;
  onJumpToConversationHit?: (hit: ConversationGlobalSearchHit) => void;
}

/**
 * Safely renders `<mark>...</mark>` (or legacy `[...]` brackets) as React
 * `<mark>` nodes without `dangerouslySetInnerHTML`.
 */
export function renderSafeSearchSnippet(snippet: string): ReactNode[] {
  if (!snippet) return [];
  const nodes: ReactNode[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>|\[([^[\]\n]{1,120})\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = pattern.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(snippet.slice(lastIndex, match.index));
    }
    const highlighted = match[1] ?? match[2] ?? '';
    nodes.push(
      <mark
        key={`mark-${keyIdx++}`}
        className="rounded-sm bg-amber-500/30 px-0.5 font-medium text-foreground"
      >
        {highlighted}
      </mark>
    );
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < snippet.length) {
    nodes.push(snippet.slice(lastIndex));
  }

  return nodes;
}

export function stripSearchHighlightMarkup(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/gi, '')
    .replace(/\[([^[\]\n]{1,120})\]/g, '$1')
    .trim();
}

export function ConversationFindBar({
  query,
  current,
  total,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
  workspaceId = null,
  defaultGlobalExpanded = false,
  searchGlobal,
  onSelectGlobalHit,
  onJumpToConversationHit,
}: ConversationFindBarProps) {
  const { t } = useTranslation(['conversation']);
  const inputRef = useRef<HTMLInputElement>(null);

  const [globalMode, setGlobalMode] = useState(defaultGlobalExpanded);
  const [page, setPage] = useState(0);
  const [globalHits, setGlobalHits] = useState<ConversationGlobalSearchHit[]>(
    []
  );
  const [hasNextPage, setHasNextPage] = useState(false);
  const [isSearchingGlobal, setIsSearchingGlobal] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setPage(0);
  }, [query, workspaceId, globalMode]);

  useEffect(() => {
    if (!globalMode) {
      setGlobalHits([]);
      setHasNextPage(false);
      setIsSearchingGlobal(false);
      return;
    }

    const trimmed = query.trim();
    if (!trimmed) {
      setGlobalHits([]);
      setHasNextPage(false);
      setIsSearchingGlobal(false);
      return;
    }

    let cancelled = false;
    setIsSearchingGlobal(true);

    const runSearch = searchGlobal ?? conversationApi.searchConversations;
    const timer = window.setTimeout(() => {
      void runSearch({
        query: trimmed,
        workspaceId,
        limit: GLOBAL_PAGE_SIZE + 1,
        offset: page * GLOBAL_PAGE_SIZE,
      })
        .then((rows) => {
          if (cancelled) return;
          if (rows.length > GLOBAL_PAGE_SIZE) {
            setGlobalHits(rows.slice(0, GLOBAL_PAGE_SIZE));
            setHasNextPage(true);
          } else {
            setGlobalHits(rows);
            setHasNextPage(rows.length === GLOBAL_PAGE_SIZE);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setGlobalHits([]);
            setHasNextPage(false);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingGlobal(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [globalMode, page, query, searchGlobal, workspaceId]);

  const formatMatchSourceLabel = (
    source: ConversationMatchSource | undefined
  ): string | null => {
    if (source === 'title') return t('find.sourceTitle');
    if (source === 'body') return t('find.sourceBody');
    if (source === 'both') return t('find.sourceBoth');
    return null;
  };

  const handleSelectHit = (hit: ConversationGlobalSearchHit) => {
    const plainSnippet = stripSearchHighlightMarkup(hit.snippet);
    const jumpDetail = {
      conversationId: hit.conversation_id,
      messageId: hit.matchedRowId ?? undefined,
      turnOrdinal: hit.matchedTurnOrdinal ?? undefined,
      snippet: plainSnippet || query.trim() || undefined,
    };

    recordPendingConversationJump(hit.conversation_id, jumpDetail);
    onSelectGlobalHit?.(hit);
    onJumpToConversationHit?.(hit);
    requestConversationScrollToQuote(jumpDetail);
  };

  const activePlaceholder = globalMode
    ? t('find.globalPlaceholder')
    : t('find.placeholder');

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <form
        className="flex h-9 items-center gap-2 px-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!globalMode) {
            onNext();
          }
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={activePlaceholder}
          aria-label={activePlaceholder}
          data-testid="conversation-find-input"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/70"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (!globalMode && event.key === 'Enter' && event.shiftKey) {
              event.preventDefault();
              onPrevious();
            }
          }}
        />

        {!globalMode ? (
          <>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {query.trim()
                ? total > 0
                  ? t('find.matches', { current, total })
                  : t('find.none')
                : null}
            </span>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('find.previous')}
              onClick={onPrevious}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('find.next')}
              onClick={onNext}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}

        <button
          type="button"
          aria-pressed={globalMode}
          onClick={() => setGlobalMode((prev) => !prev)}
          data-testid="find-bar-expand-global"
          title={
            globalMode ? t('find.collapseGlobal') : t('find.expandGlobal')
          }
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
            globalMode
              ? 'border-primary/50 bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <Globe className="h-3 w-3" />
          <span>{t('find.expandGlobal')}</span>
        </button>

        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('find.close')}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>

      {globalMode && query.trim() ? (
        <div
          data-testid="find-bar-global-results"
          className="max-h-72 overflow-y-auto border-t border-border/70 bg-background/95 px-2 py-1.5"
        >
          {isSearchingGlobal ? (
            <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{t('find.searching')}</span>
            </div>
          ) : globalHits.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t('find.none')}
            </div>
          ) : (
            <div className="space-y-1">
              {globalHits.map((hit, idx) => {
                const sourceLabel = formatMatchSourceLabel(hit.matchSource);
                return (
                  <button
                    key={`${hit.conversation_id}:${hit.matchedRowId ?? idx}`}
                    type="button"
                    onClick={() => handleSelectHit(hit)}
                    data-testid={`find-bar-global-hit-${idx}`}
                    className="flex w-full flex-col items-start gap-1 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/70"
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground">
                        {hit.title || t('children.untitled')}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {hit.matchedTurnOrdinal != null ? (
                          <span
                            data-testid={`find-hit-turn-${idx}`}
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums"
                          >
                            {t('find.turnBadge', {
                              ordinal: hit.matchedTurnOrdinal,
                            })}
                          </span>
                        ) : null}
                        {sourceLabel ? (
                          <span
                            data-testid={`find-hit-source-${idx}`}
                            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {sourceLabel}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {hit.snippet ? (
                      <div
                        data-testid={`find-hit-snippet-${idx}`}
                        className="line-clamp-2 w-full text-[11px] text-muted-foreground"
                      >
                        {renderSafeSearchSnippet(hit.snippet)}
                      </div>
                    ) : null}
                  </button>
                );
              })}

              {page > 0 || hasNextPage ? (
                <div
                  data-testid="find-bar-pagination"
                  className="flex items-center justify-between border-t border-border/60 px-2 pt-1.5 text-[11px] text-muted-foreground tabular-nums"
                >
                  <span>{t('find.pageLabel', { page: page + 1 })}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={page === 0}
                      aria-label={t('find.prevPage')}
                      data-testid="find-bar-prev-page"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={!hasNextPage}
                      aria-label={t('find.nextPage')}
                      data-testid="find-bar-next-page"
                      onClick={() => setPage((p) => p + 1)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted disabled:opacity-40"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
