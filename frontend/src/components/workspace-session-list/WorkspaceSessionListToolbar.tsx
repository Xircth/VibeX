import {
  Archive,
  ArrowLeftRight,
  ArrowUpDown,
  PanelsTopLeft,
  Check,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
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
import {
  setHideBotSessions,
  setHideDefaultWorkspace,
  setHideInactiveSessions,
  useHideBotSessions,
  useHideDefaultWorkspace,
  useHideInactiveSessions,
} from '@/lib/sessionListFilters';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { SessionListDeleteControl } from './SessionListDeleteControl';
import {
  setSessionListAppearance,
  useSessionListAppearance,
} from '@/lib/sessionListAppearance';
import type {
  SessionListSortKey,
  SessionListSortSpec,
} from './workspaceSessionListModel';

const SORT_KEYS: SessionListSortKey[] = ['name', 'time', 'agent'];

const QUICK_ACTION_BASE_CLASS =
  'flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] leading-4 font-medium text-foreground/85 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.09] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const QUICK_ACTION_ROW_CLASS = `${QUICK_ACTION_BASE_CLASS} w-full`;

function FilterSwitchMenuItem({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onCheckedChange(!checked);
      }}
      className="flex items-center justify-between gap-3 py-1.5"
    >
      <span className="flex-1 text-left">{label}</span>
      <Switch
        checked={checked}
        aria-label={label}
        onCheckedChange={onCheckedChange}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="scale-90"
      />
    </DropdownMenuItem>
  );
}

export function WorkspaceSessionListToolbar({
  isArchiveView,
  isDeleteMode,
  selectedCount,
  isDeletingSessions,
  sortSpecs,
  viewMode,
  onArchiveViewChange,
  onToggleDeleteMode,
  onCancelDeleteMode,
  onDeleteSelected,
  onCreateSession,
  onOpenSearch,
  onToggleSortKey,
  onClearSort,
  onViewModeChange,
}: {
  isArchiveView: boolean;
  isDeleteMode: boolean;
  selectedCount: number;
  isDeletingSessions: boolean;
  sortSpecs: SessionListSortSpec[];
  viewMode?: KanbanSessionListView;
  onArchiveViewChange: (value: boolean) => void;
  onToggleDeleteMode: () => void;
  onCancelDeleteMode: () => void;
  onDeleteSelected: () => void;
  onCreateSession: () => void;
  onOpenSearch: () => void;
  onToggleSortKey: (key: SessionListSortKey) => void;
  onClearSort: () => void;
  onViewModeChange?: (view: KanbanSessionListView) => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const storedViewMode = useKanbanSessionListView();
  const effectiveViewMode = viewMode ?? storedViewMode;
  const appearance = useSessionListAppearance();
  const hideDefaultWorkspace = useHideDefaultWorkspace();
  const hideBotSessions = useHideBotSessions();
  const hideInactiveSessions = useHideInactiveSessions();

  const activeFilterCount =
    Number(hideDefaultWorkspace) +
    Number(hideBotSessions) +
    Number(hideInactiveSessions);
  const hasActiveMenuState =
    isArchiveView || sortSpecs.length > 0 || activeFilterCount > 0;

  return (
    <div className="border-b border-border/60 px-2 pb-2 pt-2">
      <div className="flex w-full items-center gap-0.5">
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
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label={t('workspaceSessionList.search', '搜索会话')}
              data-testid="session-list-search-trigger"
              className={cn(QUICK_ACTION_BASE_CLASS, 'min-w-0 flex-1')}
            >
              <Search
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-left">
                {t('workspaceSessionList.searchShort', '搜索')}
              </span>
            </button>

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
                        hasActiveMenuState && 'text-foreground'
                      )}
                      aria-label={t(
                        'workspaceSessionList.moreOptions',
                        '更多选项'
                      )}
                    >
                      <MoreHorizontal
                        className={SESSION_LIST_ACTION_ICON_CLASS}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {t('workspaceSessionList.moreOptions', '更多选项')}
                </TooltipContent>
              </Tooltip>

              <DropdownMenuContent align="end" className="min-w-[13rem]">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ArrowLeftRight
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1">
                      {t('workspaceSessionList.switchView')}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={effectiveViewMode}
                      onValueChange={(value) => {
                        if (
                          value === 'status' ||
                          value === 'workspace' ||
                          value === 'mixed'
                        ) {
                          (onViewModeChange ?? setKanbanSessionListView)(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="status">
                        {t('workspaceSessionList.viewStatus', '状态分组视图')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="workspace">
                        {t(
                          'workspaceSessionList.viewWorkspace',
                          '工作区分组视图'
                        )}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="mixed">
                        {t('workspaceSessionList.viewMixed', '混合视图')}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <PanelsTopLeft
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1">
                      {t('workspaceSessionList.appearance', '会话组件样式')}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={appearance}
                      onValueChange={(value) => {
                        if (value === 'compact' || value === 'full')
                          setSessionListAppearance(value);
                      }}
                    >
                      <DropdownMenuRadioItem value="compact">
                        {t('workspaceSessionList.appearanceCompact', '精简版')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="full">
                        {t('workspaceSessionList.appearanceFull', '完整版')}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onArchiveViewChange(!isArchiveView)}
                >
                  <Archive
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex-1">
                    {isArchiveView
                      ? t('workspaceSessionList.backToSessionList')
                      : t('workspaceSessionList.openArchive')}
                  </span>
                  {isArchiveView ? (
                    <Check
                      className="h-3.5 w-3.5 shrink-0 text-foreground"
                      aria-hidden="true"
                    />
                  ) : null}
                </DropdownMenuItem>

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ArrowUpDown
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1">
                      {t('workspaceSessionList.sort')}
                    </span>
                    {sortSpecs.length > 0 ? (
                      <span className="rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                        {sortSpecs.length}
                      </span>
                    ) : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[11.5rem]">
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
                              <span className="text-[10px] text-muted-foreground tabular-nums">
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
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onClearSort}>
                          {t('workspaceSessionList.sortClear')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuItem onSelect={onToggleDeleteMode}>
                  <Trash2
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex-1">
                    {t('workspaceSessionList.bulkDelete')}
                  </span>
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <SlidersHorizontal
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1">
                      {t('workspaceSessionList.filter', '筛选')}
                    </span>
                    {activeFilterCount > 0 ? (
                      <span className="rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                        {activeFilterCount}
                      </span>
                    ) : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[16rem]">
                    <FilterSwitchMenuItem
                      label={t(
                        'workspaceSessionList.hideDefaultWorkspace',
                        '隐藏默认工作区'
                      )}
                      checked={hideDefaultWorkspace}
                      onCheckedChange={setHideDefaultWorkspace}
                    />
                    <FilterSwitchMenuItem
                      label={t(
                        'workspaceSessionList.hideBotSessions',
                        '隐藏Bot会话'
                      )}
                      checked={hideBotSessions}
                      onCheckedChange={setHideBotSessions}
                    />
                    <FilterSwitchMenuItem
                      label={t(
                        'workspaceSessionList.hideInactiveSessions',
                        '隐藏长期(7天)不活跃会话'
                      )}
                      checked={hideInactiveSessions}
                      onCheckedChange={setHideInactiveSessions}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <ShellNavPanelDragHandle panelId={PANEL_IDS.SESSION_LIST} />
      </div>

      {!isDeleteMode ? (
        <div
          className="mt-0.5 flex flex-col gap-0.5"
          data-testid="session-list-quick-actions"
        >
          <button
            type="button"
            onClick={onCreateSession}
            aria-label={t('workspaceSessionList.newSession')}
            className={QUICK_ACTION_ROW_CLASS}
          >
            <MessageSquarePlus
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
              data-testid="new-session-icon"
            />
            <span className="min-w-0 flex-1 truncate text-left">
              {t('workspaceSessionList.quickNewSession', '新会话')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void openInSystemBrowser(getSiteUrl('/#download'))}
            aria-label={t('workspaceSessionList.mobileApp', '移动端APP')}
            className={QUICK_ACTION_ROW_CLASS}
          >
            <Smartphone
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
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
