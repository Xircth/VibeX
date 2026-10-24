import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';

import { GroupAvatar } from './GroupAvatar';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import type { ThreadListItem } from './threadModel';

type Entry = {
  key: string;
  kind: ThreadListItem['kind'];
  name: string;
  memberNames: string[];
  memberIds: string[];
};

/** Case-insensitive match on the entry name or any group member name. */
export function filterSearchEntries<
  T extends Pick<Entry, 'name' | 'memberNames'>,
>(entries: readonly T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...entries];
  return entries.filter(
    (entry) =>
      entry.name.toLocaleLowerCase().includes(q) ||
      entry.memberNames.some((n) => n.toLocaleLowerCase().includes(q))
  );
}

/**
 * Spotlight-style search over members and group chats. Selecting a row calls
 * `onSelect(key)` — the same handler the sidebar list rows use.
 */
export function CollabSearchModal({
  open,
  items,
  avatarFor,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  items: readonly ThreadListItem[];
  avatarFor: (memberId: string, nickname: string) => MemberBotAvatarConfig;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation('panels');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const entries = useMemo<Entry[]>(() => {
    const nicknameById = new Map<string, string>();
    for (const item of items)
      if (item.kind === 'member')
        nicknameById.set(item.member.memberId, item.member.nickname);
    return items.map((item) =>
      item.kind === 'member'
        ? {
            key: item.key,
            kind: 'member',
            name: item.member.nickname,
            memberNames: [],
            memberIds: [item.member.memberId],
          }
        : {
            key: item.key,
            kind: 'group',
            name: item.group.name,
            memberIds: item.group.memberIds,
            memberNames: item.group.memberIds.map(
              (id) => nicknameById.get(id) ?? id
            ),
          }
    );
  }, [items]);

  const results = useMemo(
    () => filterSearchEntries(entries, query),
    [entries, query]
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (key: string) => {
    onOpenChange(false);
    onSelect(key);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length) setActive((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length)
        setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = results[active];
      if (entry) choose(entry.key);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  return createPortal(
    <div
      data-floating-layer="modal"
      className="collab-search-layer"
      data-testid="collab-search-modal"
    >
      <NativeSurfaceOcclusionHold />
      <div
        className="dialog-backdrop fixed inset-0"
        aria-hidden="true"
        data-testid="collab-search-backdrop"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('collaborationSpace.searchOpen')}
        className="dialog-surface collab-search-card"
        onKeyDown={onKeyDown}
      >
        <div className="collab-search-input-row">
          <Search className="h-4 w-4 collab-search-input-icon" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            className="collab-search-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="collab-search-results"
            aria-activedescendant={
              results[active]
                ? `collab-search-${results[active].key}`
                : undefined
            }
            aria-label={t('collaborationSpace.searchPlaceholder')}
            placeholder={t('collaborationSpace.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="collab-search-divider" />
        {results.length === 0 ? (
          <p className="collab-search-empty">
            {t('collaborationSpace.searchEmpty')}
          </p>
        ) : (
          <ul
            ref={listRef}
            id="collab-search-results"
            role="listbox"
            aria-label={t('collaborationSpace.searchResults')}
            className="collab-search-list"
          >
            {results.map((entry, index) => (
              <li
                key={entry.key}
                id={`collab-search-${entry.key}`}
                role="option"
                aria-selected={index === active}
                data-index={index}
                data-kind={entry.kind}
                data-testid={`collab-search-row-${entry.key}`}
                className={cn(
                  'collab-search-row',
                  index === active && 'is-active'
                )}
                onMouseMove={() => index !== active && setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(entry.key)}
              >
                {entry.kind === 'member' ? (
                  <MemberBotAvatar
                    config={avatarFor(entry.memberIds[0], entry.name)}
                    animated={false}
                    className="h-8 w-8 shrink-0"
                  />
                ) : (
                  <GroupAvatar
                    avatars={entry.memberIds
                      .slice(0, 4)
                      .map((id, i) =>
                        avatarFor(id, entry.memberNames[i] ?? id)
                      )}
                    className="h-8 w-8 shrink-0"
                    data-testid="collab-search-group-avatar"
                  />
                )}
                <span className="collab-search-text">
                  <span className="collab-search-name">{entry.name}</span>
                  {entry.kind === 'group' && entry.memberNames.length ? (
                    <span className="collab-search-sub">
                      {entry.memberNames.join(', ')}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body
  );
}
