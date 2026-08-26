import {
  GitCommitHorizontal,
  Hash,
  MessageSquare,
  FileIcon,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  AT_REFERENCE_TAB_ORDER,
  type AtReferenceGroup,
  type AtReferenceItem,
  type AtReferenceTab,
} from './composerAtReferences';

const TAB_ICON = {
  file: FileIcon,
  conversation: MessageSquare,
  commit: GitCommitHorizontal,
  instruction: Hash,
} as const;

export function ComposerAtReferenceMenu({
  groups,
  activeTab,
  selectedIndex,
  loading,
  onSelectTab,
  onSelectItem,
  onHighlight,
}: {
  groups: AtReferenceGroup[];
  activeTab: AtReferenceTab;
  selectedIndex: number;
  loading: boolean;
  onSelectTab: (tab: AtReferenceTab) => void;
  onSelectItem: (item: AtReferenceItem) => void;
  onHighlight: (index: number) => void;
}) {
  const { t } = useTranslation('tasks');
  const groupByTab = new Map(groups.map((group) => [group.tab, group]));
  const activeGroup = groupByTab.get(activeTab);
  const items = loading ? [] : (activeGroup?.items ?? []);

  return (
    <div
      className="composer-at-reference-menu dialog-surface flex max-h-[min(18rem,calc(100dvh_-_1rem))] w-full flex-col overflow-hidden rounded-[14px] text-popover-foreground shadow-[var(--shadow-popover)]"
      data-testid="composer-at-reference-menu"
    >
      <div
        role="tablist"
        aria-label={t('composer.atReference.listbox')}
        aria-orientation="horizontal"
        className="flex shrink-0 gap-0.5 overflow-x-auto p-1"
      >
        {AT_REFERENCE_TAB_ORDER.map((tab) => {
          const count = loading ? 0 : (groupByTab.get(tab)?.items.length ?? 0);
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
                <span className="text-[0.7rem] tabular-nums opacity-80">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {t('composer.atReference.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {t('composer.atReference.empty')}
          </div>
        ) : (
          <div
            role="listbox"
            aria-label={`${t('composer.atReference.listbox')}: ${t(
              `composer.atReference.tabs.${activeTab}`
            )}`}
          >
            {items.map((item, index) => {
              const Icon = TAB_ICON[item.tab];
              const active = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'hover:bg-[var(--surface-control)]'
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectItem(item);
                  }}
                  onMouseEnter={() => onHighlight(index)}
                >
                  <Icon
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate text-xs font-medium">
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="min-w-0 grow basis-24 truncate text-[0.625rem] leading-[0.875rem] text-muted-foreground">
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
  left,
  top,
  width,
  onSelectTab,
  onSelectItem,
  onHighlight,
}: {
  groups: AtReferenceGroup[];
  activeTab: AtReferenceTab;
  selectedIndex: number;
  loading: boolean;
  left: number;
  top: number;
  width: number;
  onSelectTab: (tab: AtReferenceTab) => void;
  onSelectItem: (item: AtReferenceItem) => void;
  onHighlight: (index: number) => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        width,
        top: Math.max(8, top - 8),
        transform: 'translateY(-100%)',
        zIndex: 50,
      }}
    >
      <ComposerAtReferenceMenu
        groups={groups}
        activeTab={activeTab}
        selectedIndex={selectedIndex}
        loading={loading}
        onSelectTab={onSelectTab}
        onSelectItem={onSelectItem}
        onHighlight={onHighlight}
      />
    </div>,
    document.body
  );
}
