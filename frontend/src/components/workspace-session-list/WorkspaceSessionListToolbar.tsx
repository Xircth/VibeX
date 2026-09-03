import {
  Archive,
  ArrowUpDown,
  Check,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import { cn } from '@/lib/utils';
import type {
  SessionListSortKey,
  SessionListSortSpec,
} from './workspaceSessionListModel';

const SORT_KEYS: SessionListSortKey[] = ['name', 'time', 'agent'];

export function WorkspaceSessionListToolbar({
  isArchiveView,
  isDeleteMode,
  selectedCount,
  isDeletingSessions,
  searchQuery,
  sortSpecs,
  onArchiveViewChange,
  onToggleDeleteMode,
  onCancelDeleteMode,
  onDeleteSelected,
  onCreateSession,
  onSearchQueryChange,
  onToggleSortKey,
  onClearSort,
}: {
  isArchiveView: boolean;
  isDeleteMode: boolean;
  selectedCount: number;
  isDeletingSessions: boolean;
  searchQuery: string;
  sortSpecs: SessionListSortSpec[];
  onArchiveViewChange: (value: boolean) => void;
  onToggleDeleteMode: () => void;
  onCancelDeleteMode: () => void;
  onDeleteSelected: () => void;
  onCreateSession: () => void;
  onSearchQueryChange: (value: string) => void;
  onToggleSortKey: (key: SessionListSortKey) => void;
  onClearSort: () => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const primarySort = sortSpecs[sortSpecs.length - 1] ?? null;
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (isSearchExpanded) {
      searchInputRef.current?.focus();
    }
  }, [isSearchExpanded]);

  return (
    <div className="space-y-2 px-1.5 pb-1 pt-1.5">
      <div className="flex w-full items-center justify-start gap-1">
        <div className="flex min-w-0 flex-1 items-center justify-start gap-1">
          <div
            className={cn(
              'relative h-7 overflow-hidden motion-reduce:transition-none',
              'transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              isSearchExpanded ? 'w-full' : 'w-7 shrink-0'
            )}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              hidden={isSearchExpanded}
              className={cn(
                SESSION_LIST_ACTION_BUTTON_CLASS,
                'absolute inset-0',
                searchQuery && 'text-foreground',
                isSearchExpanded && 'hidden'
              )}
              aria-label={t('workspaceSessionList.search')}
              aria-expanded={false}
              onClick={() => setIsSearchExpanded(true)}
            >
              <Search className={SESSION_LIST_ACTION_ICON_CLASS} />
            </Button>
            <Search
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground',
                !isSearchExpanded && 'hidden'
              )}
            />
            <Input
              ref={searchInputRef}
              hidden={!isSearchExpanded}
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onBlur={() => setIsSearchExpanded(false)}
              placeholder={t('workspaceSessionList.searchPlaceholder')}
              aria-label={t('workspaceSessionList.search')}
              aria-expanded={true}
              className={cn(
                'h-7 w-full pl-8 text-xs',
                !isSearchExpanded && 'hidden'
              )}
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                hidden={isSearchExpanded}
                className={cn(
                  SESSION_LIST_ACTION_BUTTON_CLASS,
                  isSearchExpanded && 'hidden'
                )}
                aria-label={t('workspaceSessionList.newSession')}
                onClick={onCreateSession}
              >
                <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('workspaceSessionList.newSession')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                hidden={isSearchExpanded}
                className={cn(
                  SESSION_LIST_ACTION_BUTTON_CLASS,
                  isArchiveView && 'text-foreground',
                  isSearchExpanded && 'hidden'
                )}
                aria-label={
                  isArchiveView
                    ? t('workspaceSessionList.backToSessionList')
                    : t('workspaceSessionList.openArchive')
                }
                onClick={() => onArchiveViewChange(!isArchiveView)}
              >
                <Archive className={SESSION_LIST_ACTION_ICON_CLASS} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isArchiveView
                ? t('workspaceSessionList.backToSessionList')
                : t('workspaceSessionList.openArchive')}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    hidden={isSearchExpanded}
                    className={cn(
                      SESSION_LIST_ACTION_BUTTON_CLASS,
                      primarySort && 'text-foreground',
                      isSearchExpanded && 'hidden'
                    )}
                    aria-label={t('workspaceSessionList.sort')}
                  >
                    <ArrowUpDown className={SESSION_LIST_ACTION_ICON_CLASS} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('workspaceSessionList.sort')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[11rem]">
              {SORT_KEYS.map((key) => {
                const specIndex = sortSpecs.findIndex(
                  (spec) => spec.key === key
                );
                const spec = specIndex >= 0 ? sortSpecs[specIndex] : null;
                const order =
                  specIndex >= 0 ? sortSpecs.length - specIndex : null;
                return (
                  <DropdownMenuItem
                    key={key}
                    onSelect={(event) => {
                      event.preventDefault();
                      onToggleSortKey(key);
                    }}
                  >
                    <span className="flex flex-1 items-center gap-2">
                      {t(`workspaceSessionList.sort${capitalize(key)}`)}
                      {spec ? (
                        <span className="text-[10px] text-muted-foreground">
                          {order}
                          {spec.direction === 'desc' ? '↓' : '↑'}
                        </span>
                      ) : null}
                    </span>
                    {spec ? (
                      <Check className="h-3.5 w-3.5 text-foreground" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                  </DropdownMenuItem>
                );
              })}
              {sortSpecs.length > 0 ? (
                <DropdownMenuItem onSelect={onClearSort}>
                  {t('workspaceSessionList.sortClear')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                hidden={isSearchExpanded}
                className={cn(
                  SESSION_LIST_ACTION_BUTTON_CLASS,
                  isDeleteMode
                    ? 'text-destructive hover:text-destructive'
                    : undefined,
                  isSearchExpanded && 'hidden'
                )}
                aria-label={
                  isDeleteMode
                    ? t('workspaceSessionList.exitDeleteMode')
                    : t('workspaceSessionList.bulkDelete')
                }
                onClick={onToggleDeleteMode}
              >
                <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isDeleteMode
                ? t('workspaceSessionList.exitDeleteMode')
                : t('workspaceSessionList.bulkDelete')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {isDeleteMode ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px]">
          <span className="text-muted-foreground">
            {selectedCount > 0
              ? t('workspaceSessionList.selectedCount', {
                  count: selectedCount,
                })
              : t('workspaceSessionList.selectSessionsToDelete')}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="destructive"
              className="h-6 px-2 text-[11px]"
              disabled={selectedCount === 0 || isDeletingSessions}
              onClick={onDeleteSelected}
            >
              {isDeletingSessions
                ? t('workspaceSessionList.deleting')
                : t('workspaceSessionList.deleteSelected')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={isDeletingSessions}
              onClick={onCancelDeleteMode}
            >
              {t('common:cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
