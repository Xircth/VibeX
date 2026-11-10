import {
  Archive,
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  Plus,
  Search,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
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
import { ShellNavPanelDragHandle } from '@/components/layout/ShellNavPanelDragHandle';
import { openInSystemBrowser } from '@/hooks/useOpenLink';
import { getSiteUrl } from '@/lib/branding';
import {
  type KanbanSessionListView,
  setKanbanSessionListView,
  useKanbanSessionListView,
} from '@/lib/kanbanSessionListView';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { SessionListDeleteControl } from './SessionListDeleteControl';
import type {
  SessionListSortKey,
  SessionListSortSpec,
} from './workspaceSessionListModel';

const SORT_KEYS: SessionListSortKey[] = ['name', 'time', 'agent'];

const QUICK_ACTION_ROW_CLASS =
  'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-foreground/[0.06] active:bg-foreground/[0.09] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function WorkspaceSessionListToolbar({
  isArchiveView,
  isDeleteMode,
  selectedCount,
  isDeletingSessions,
  searchQuery,
  sortSpecs,
  viewMode,
  onArchiveViewChange,
  onToggleDeleteMode,
  onCancelDeleteMode,
  onDeleteSelected,
  onCreateSession,
  onSearchQueryChange,
  onToggleSortKey,
  onClearSort,
  onToggleViewMode,
}: {
  isArchiveView: boolean;
  isDeleteMode: boolean;
  selectedCount: number;
  isDeletingSessions: boolean;
  searchQuery: string;
  sortSpecs: SessionListSortSpec[];
  viewMode?: KanbanSessionListView;
  onArchiveViewChange: (value: boolean) => void;
  onToggleDeleteMode: () => void;
  onCancelDeleteMode: () => void;
  onDeleteSelected: () => void;
  onCreateSession: () => void;
  onSearchQueryChange: (value: string) => void;
  onToggleSortKey: (key: SessionListSortKey) => void;
  onClearSort: () => void;
  onToggleViewMode?: () => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const storedViewMode = useKanbanSessionListView();
  const effectiveViewMode = viewMode ?? storedViewMode;
  const primarySort = sortSpecs[sortSpecs.length - 1] ?? null;

  const handleToggleViewMode = () => {
    if (onToggleViewMode) {
      onToggleViewMode();
      return;
    }
    setKanbanSessionListView(
      effectiveViewMode === 'workspace' ? 'status' : 'workspace'
    );
  };

  return (
    <div className="border-b border-border/60 px-2 pb-2 pt-2">
      <div className="flex w-full items-center gap-1">
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
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-foreground/[0.06] px-2.5 transition-colors focus-within:bg-foreground/[0.09]">
              <Search
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder={t('workspaceSessionList.searchPlaceholder')}
                aria-label={t('workspaceSessionList.search')}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange('')}
                  aria-label={t('common:clear', 'Clear')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn(
                    SESSION_LIST_ACTION_BUTTON_CLASS,
                    isArchiveView && 'text-foreground'
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
                      className={cn(
                        SESSION_LIST_ACTION_BUTTON_CLASS,
                        primarySort && 'text-foreground'
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
                  className={SESSION_LIST_ACTION_BUTTON_CLASS}
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
        <ShellNavPanelDragHandle panelId={PANEL_IDS.SESSION_LIST} />
      </div>

      {!isDeleteMode ? (
        <div
          className="mt-1.5 flex flex-col gap-0.5"
          data-testid="session-list-quick-actions"
        >
          <button
            type="button"
            onClick={onCreateSession}
            aria-label={t('workspaceSessionList.newSession')}
            className={QUICK_ACTION_ROW_CLASS}
          >
            <Plus
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-left">
              {t('workspaceSessionList.quickNewSession', '新会话')}
            </span>
          </button>

          <button
            type="button"
            onClick={handleToggleViewMode}
            aria-label={t(
              'workspaceSessionList.switchView',
              '切换视图（工作区/状态视图）'
            )}
            className={QUICK_ACTION_ROW_CLASS}
          >
            <ArrowLeftRight
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-left">
              {t(
                'workspaceSessionList.switchView',
                '切换视图（工作区/状态视图）'
              )}
            </span>
            <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {effectiveViewMode === 'status'
                ? t('workspaceSessionList.viewStatusShort', '状态')
                : t('workspaceSessionList.viewWorkspaceShort', '工作区')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void openInSystemBrowser(getSiteUrl('/#download'))}
            aria-label={t('workspaceSessionList.mobileApp', '移动端APP')}
            className={QUICK_ACTION_ROW_CLASS}
          >
            <Smartphone
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-left">
              {t('workspaceSessionList.mobileApp', '移动端APP')}
            </span>
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
              Beta
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
