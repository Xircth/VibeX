import {
  AtSign,
  Folder,
  GitCommitHorizontal,
  Hash,
  MessageSquare,
  FileIcon,
  Server,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
} from '@/features/collaboration/MemberBotAvatar';
import { cn } from '@/lib/utils';
import {
  atReferenceTabOrder,
  type AtReferenceGroup,
  type AtReferenceItem,
  type AtReferenceTab,
} from './composerAtReferences';

const TAB_ICON = {
  member: AtSign,
  file: FileIcon,
  project: Folder,
  conversation: MessageSquare,
  commit: GitCommitHorizontal,
  instruction: Hash,
  host: Server,
  action: Sparkles,
} as const;

export function ComposerAtReferenceMenu({
  groups,
  activeTab,
  selectedIndex,
  loading,
  onSelectTab,
  onSelectItem,
}: {
  groups: AtReferenceGroup[];
  activeTab: AtReferenceTab;
  selectedIndex: number;
  loading: boolean;
  onSelectTab: (tab: AtReferenceTab) => void;
  onSelectItem: (item: AtReferenceItem) => void;
  onHighlight?: (index: number) => void;
}) {
  const { t } = useTranslation('tasks');
  const listboxRef = useRef<HTMLDivElement>(null);
  const groupByTab = new Map(groups.map((group) => [group.tab, group]));
  const activeGroup = groupByTab.get(activeTab);
  const items = activeGroup?.items ?? [];
  const tabOrder = atReferenceTabOrder(groups);

  useEffect(() => {
    const activeOption = listboxRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    );
    if (activeOption && typeof activeOption.scrollIntoView === 'function') {
      activeOption.scrollIntoView({ block: 'nearest' });
    }
  }, [activeTab, selectedIndex]);

  return (
    <div
      className="composer-at-reference-menu composer-status-surface flex max-h-[min(18rem,calc(100dvh_-_1rem))] w-full flex-col overflow-hidden text-foreground"
      data-testid="composer-at-reference-menu"
    >
      <div
        role="tablist"
        aria-label={t('composer.atReference.listbox')}
        aria-orientation="horizontal"
        className="composer-at-reference-tabs flex shrink-0 gap-0.5 overflow-x-auto p-1"
      >
        {tabOrder.map((tab) => {
          const count = groupByTab.get(tab)?.items.length ?? 0;
          const selected = tab === activeTab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={selected}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
                selected
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-[var(--surface-control)]'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelectTab(tab)}
            >
              <span>{t(`composer.atReference.tabs.${tab}`)}</span>
              {!loading && count > 0 ? (
                <span className="text-xs tabular-nums opacity-80">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {items.length === 0 && loading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {t('composer.atReference.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {t('composer.atReference.empty')}
          </div>
        ) : (
          <div
            ref={listboxRef}
            role="listbox"
            aria-label={`${t('composer.atReference.listbox')}: ${t(
              `composer.atReference.tabs.${activeTab}`
            )}`}
          >
            {items.map((item, index) => {
              const Icon = TAB_ICON[item.tab];
              const active = index === selectedIndex;
              const mentionAll = item.mentionAll === true;
              const memberAvatar =
                item.tab === 'member' && !mentionAll
                  ? (item.memberAvatar ?? deriveMemberBotAvatar(item.label))
                  : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  className={cn(
                    'composer-at-reference-option relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent hover:text-accent-foreground',
                    active && 'bg-accent text-accent-foreground'
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectItem(item);
                  }}
                >
                  {mentionAll ? (
                    <span
                      aria-hidden="true"
                      data-composer-at-mention-all-icon
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-control)] text-foreground"
                    >
                      <AtSign className="h-3.5 w-3.5" />
                    </span>
                  ) : memberAvatar ? (
                    <MemberBotAvatar
                      config={memberAvatar}
                      className="h-7 w-7 shrink-0"
                      lead={item.isLead === true}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-300"
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <span
                    data-composer-at-reference-label
                    className={cn(
                      'min-w-0 truncate text-xs',
                      mentionAll
                        ? 'font-bold text-foreground'
                        : 'font-medium text-foreground'
                    )}
                    style={
                      mentionAll
                        ? undefined
                        : memberAvatar?.color
                          ? { color: memberAvatar.color }
                          : undefined
                    }
                  >
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="min-w-0 grow basis-24 truncate text-[10px] leading-[0.875rem] text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ComposerAtReferencePanel({
  groups,
  activeTab,
  selectedIndex,
  loading,
  anchor,
  onSelectTab,
  onSelectItem,
}: {
  groups: AtReferenceGroup[];
  activeTab: AtReferenceTab;
  selectedIndex: number;
  loading: boolean;
  anchor?: HTMLElement | null;
  onSelectTab: (tab: AtReferenceTab) => void;
  onSelectItem: (item: AtReferenceItem) => void;
  onHighlight?: (index: number) => void;
}) {
  if (typeof document === 'undefined') return null;
  const menu = (
    <ComposerAtReferenceMenu
      groups={groups}
      activeTab={activeTab}
      selectedIndex={selectedIndex}
      loading={loading}
      onSelectTab={onSelectTab}
      onSelectItem={onSelectItem}
    />
  );
  const host =
    anchor?.closest('[data-testid="session-composer-anchor"]') ??
    anchor?.closest('[data-testid="session-composer-stack"]') ??
    anchor ??
    null;
  return host ? createPortal(menu, host) : menu;
}
