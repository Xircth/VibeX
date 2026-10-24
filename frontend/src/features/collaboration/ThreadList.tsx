import { useMemo, useState } from 'react';
import {
  LayoutGrid,
  MessagesSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  TriangleAlert,
  User,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { CollabSearchModal } from './CollabSearchModal';
import { CollaborationSpaceIcon } from './CollaborationSpaceCollectionPanel';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  THREAD_COPY,
  type ThreadFilter,
  type ThreadListItem,
} from './threadModel';

function compactAge(at: string | null | undefined, now: number): string {
  if (!at) return '';
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  return `${Math.floor(hours / 24)}天`;
}

export function ThreadList({
  items,
  searchItems,
  selectedKey,
  filter,
  query,
  avatarFor,
  onFilterChange,
  onSelect,
  onTogglePin,
  onNewGroup,
  onNewMember,
  banner,
  now = Date.now(),
}: {
  items: readonly ThreadListItem[];
  /** Unfiltered items for the search modal; defaults to `items`. */
  searchItems?: readonly ThreadListItem[];
  selectedKey: string | null;
  filter: ThreadFilter;
  query: string;
  avatarFor: (memberId: string, nickname: string) => MemberBotAvatarConfig;
  onFilterChange: (filter: ThreadFilter) => void;
  onQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
  onNewGroup: () => void;
  onNewMember: () => void;
  banner?: React.ReactNode;
  now?: number;
}) {
  const { t } = useTranslation('panels');
  const [searchOpen, setSearchOpen] = useState(false);
  const nicknameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.kind === 'member')
        map.set(item.member.memberId, item.member.nickname);
    }
    return map;
  }, [items]);

  return (
    <nav
      className="collab-list"
      aria-label={THREAD_COPY.title}
      data-testid="collab-thread-list"
    >
      <div className="collab-list-head">
        <SegmentedControl
          label={THREAD_COPY.title}
          size="sm"
          layout="hug"
          className="collaboration-compact-segmented collab-list-filter"
          value={filter}
          onChange={(value) => onFilterChange(value as ThreadFilter)}
        >
          <SegmentedControlItem
            value="all"
            label={THREAD_COPY.filterAll}
            icon={<LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />}
          />
          <SegmentedControlItem
            value="member"
            label={THREAD_COPY.filterMembers}
            icon={<User className="h-3.5 w-3.5" aria-hidden="true" />}
          />
          <SegmentedControlItem
            value="group"
            label={THREAD_COPY.filterGroups}
            icon={<MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />}
          />
        </SegmentedControl>
        <span className="collab-list-head-spacer" />
        <Button
          variant="icon"
          size="sm"
          aria-label={t('collaborationSpace.searchOpen')}
          title={t('collaborationSpace.searchOpen')}
          aria-haspopup="dialog"
          data-testid="collab-search-button"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="icon"
          size="sm"
          aria-label={THREAD_COPY.newMember}
          title={THREAD_COPY.newMember}
          onClick={onNewMember}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="icon"
          size="sm"
          aria-label={THREAD_COPY.newGroup}
          title={THREAD_COPY.newGroup}
          onClick={onNewGroup}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {banner}
      <CollabSearchModal
        open={searchOpen}
        items={searchItems ?? items}
        avatarFor={avatarFor}
        onOpenChange={setSearchOpen}
        onSelect={onSelect}
      />
      {items.length === 0 ? (
        <p className="collab-empty-hint">
          {query ? THREAD_COPY.emptySearch : THREAD_COPY.emptyList}
        </p>
      ) : (
        <ul className="collab-list-rows" aria-label={THREAD_COPY.title}>
          {items.map((item) => {
            const selected = item.key === selectedKey;
            const name =
              item.kind === 'member'
                ? item.member.nickname
                : `#${item.group.name}`;
            const subtitle =
              item.kind === 'member'
                ? (item.presence.line ?? item.activity.text ?? '')
                : (item.activity.text ?? '');
            return (
              <li
                key={item.key}
                className="collaboration-member-row-outer collab-list-row"
                data-testid={`collab-row-${item.key}`}
                data-kind={item.kind}
              >
                <div
                  className={cn(
                    'workspace-session-row collaboration-member-row flex-1 min-w-0',
                    selected && 'is-selected'
                  )}
                >
                  <button
                    type="button"
                    className="workspace-session-row-main"
                    aria-label={name}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(item.key)}
                  >
                    <span
                      className="workspace-session-icon collab-list-row-icon"
                      aria-hidden="true"
                    >
                      {item.kind === 'member' ? (
                        <>
                          <MemberBotAvatar
                            config={avatarFor(
                              item.member.memberId,
                              item.member.nickname
                            )}
                            sessionActive={item.presence.state === 'busy'}
                            className="h-7 w-7"
                          />
                          <span
                            className={cn(
                              'workspace-session-status',
                              `workspace-session-status--${item.presence.state}`
                            )}
                          />
                        </>
                      ) : (
                        <CollaborationSpaceIcon
                          avatars={item.group.memberIds
                            .slice(0, 4)
                            .map((id) =>
                              avatarFor(id, nicknameById.get(id) ?? id)
                            )}
                          className="h-7 w-7"
                        />
                      )}
                    </span>
                    <span className="collaboration-member-title-group">
                      <span className="collaboration-member-name">
                        {name}
                        {item.kind === 'group' ? (
                          <span className="collaboration-team-pill ml-2">
                            {THREAD_COPY.groupPill(item.group.memberIds.length)}
                          </span>
                        ) : null}
                      </span>
                      {subtitle ? (
                        <span
                          className="collaboration-member-subtitle collaboration-member-last-message collab-presence-line"
                          data-state={
                            item.kind === 'member'
                              ? item.presence.state
                              : undefined
                          }
                        >
                          {subtitle}
                        </span>
                      ) : null}
                    </span>
                    <span className="collab-list-row-meta">
                      <span className="collab-list-row-meta-top">
                        {item.activity.warning ? (
                          <TriangleAlert
                            className="h-3.5 w-3.5 collab-card-icon--warning"
                            aria-label={THREAD_COPY.conflictTitle}
                          />
                        ) : null}
                        {item.pinned ? (
                          <Pin
                            className="h-3 w-3"
                            aria-label={THREAD_COPY.pin}
                          />
                        ) : null}
                        <span>{compactAge(item.activity.at, now)}</span>
                      </span>
                      {item.attention > 0 ? (
                        <span
                          className="collaboration-unread-badge collaboration-attention-badge"
                          aria-label={THREAD_COPY.needsYou}
                          data-testid="collab-attention-badge"
                        >
                          {item.attention}
                        </span>
                      ) : item.activity.unread ? (
                        <span className="collaboration-unread-badge">
                          {item.activity.unread}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
                <Button
                  variant="icon"
                  size="xs"
                  className="collab-list-row-pin"
                  data-pinned={item.pinned}
                  aria-label={item.pinned ? THREAD_COPY.unpin : THREAD_COPY.pin}
                  title={item.pinned ? THREAD_COPY.unpin : THREAD_COPY.pin}
                  onClick={() => onTogglePin(item.key)}
                >
                  {item.pinned ? (
                    <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
