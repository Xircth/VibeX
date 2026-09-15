import { Archive, ArrowUpDown, Check, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { SessionListDeleteControl } from './SessionListDeleteControl';
import { SessionListSearchControl } from './SessionListSearchControl';
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

  return (
    <div className="px-1.5 pb-1 pt-1.5">
      <div className="flex w-full items-center justify-start gap-1">
        {isDeleteMode ? (
          <SessionListDeleteControl
            selectedCount={selectedCount}
            isDeleting={isDeletingSessions}
            selectLabel={t('workspaceSessionList.selectSessionsToDelete')}
            selectedCountLabel={t('workspaceSessionList.selectedCount', {
              count: selectedCount,
            })}
            deleteLabel={t('workspaceSessionList.deleteSelected')}
            deletingLabel={t('workspaceSessionList.deleting')}
            cancelLabel={t('common:cancel')}
            onDelete={onDeleteSelected}
            onCancel={onCancelDeleteMode}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-start gap-1">
            <SessionListSearchControl
              searchQuery={searchQuery}
              isExpanded={isSearchExpanded}
              searchLabel={t('workspaceSessionList.search')}
              placeholder={t('workspaceSessionList.searchPlaceholder')}
              onSearchQueryChange={onSearchQueryChange}
              onExpandedChange={setIsSearchExpanded}
            />

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
                <TooltipContent>
                  {t('workspaceSessionList.sort')}
                </TooltipContent>
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
                    isSearchExpanded && 'hidden'
                  )}
                  aria-label={t('workspaceSessionList.bulkDelete')}
                  onClick={onToggleDeleteMode}
                >
                  <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('workspaceSessionList.bulkDelete')}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
