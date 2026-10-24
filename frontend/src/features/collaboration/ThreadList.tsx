import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronRight,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { CollabSearchModal } from './CollabSearchModal';
import { CollaborationSpaceIcon } from './CollaborationSpaceCollectionPanel';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  sectionThreadItems,
  useCollabSidebarGroupsStore,
} from './collabSidebarGroupsStore';
import { THREAD_COPY, type ThreadListItem } from './threadModel';

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
  query,
  avatarFor,
  onSelect,
  onTogglePin,
  onNewGroup,
  onNewMember,
  groupCreatorOpen = false,
  groupCreator,
  now = Date.now(),
}: {
  items: readonly ThreadListItem[];
  /** Unfiltered items for the search modal; defaults to `items`. */
  searchItems?: readonly ThreadListItem[];
  selectedKey: string | null;
  query: string;
  avatarFor: (memberId: string, nickname: string) => MemberBotAvatarConfig;
  onQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
  onNewGroup: () => void;
  onNewMember: () => void;
  groupCreatorOpen?: boolean;
  groupCreator?: React.ReactNode;
  now?: number;
}) {
  const { t } = useTranslation('panels');
  const [searchOpen, setSearchOpen] = useState(false);
  const folders = useCollabSidebarGroupsStore((st) => st.groups);
  const createFolder = useCollabSidebarGroupsStore((st) => st.createGroup);
  const renameFolder = useCollabSidebarGroupsStore((st) => st.renameGroup);
  const deleteFolder = useCollabSidebarGroupsStore((st) => st.deleteGroup);
  const moveItem = useCollabSidebarGroupsStore((st) => st.moveItem);
  const toggleCollapsed = useCollabSidebarGroupsStore(
    (st) => st.toggleCollapsed
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ProductContextMenuItem[];
  } | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
    null
  );
  const g = (key: string, opts?: Record<string, string>) =>
    t(`collaborationSpace.sidebarGroups.${key}`, opts);
  const sections = useMemo(
    () => sectionThreadItems(items, folders),
    [items, folders]
  );
  const openMenu = (event: MouseEvent, menuItems: ProductContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items: menuItems });
  };
  const rowMenu = (key: string): ProductContextMenuItem[] => {
    const current = folders.find((f) => f.itemKeys.includes(key));
    const targets = folders.filter((f) => f.id !== current?.id);
    const entries: ProductContextMenuItem[] = [
      {
        id: 'new-group',
        label: g('newGroup'),
        icon: FolderPlus,
        onSelect: () => {
          const name = g('defaultName');
          const id = createFolder(name, key);
          startEditing(id, name);
        },
      },
      {
        type: 'submenu',
        id: 'move-to',
        label: g('moveTo'),
        icon: FolderInput,
        disabled: targets.length === 0,
        disabledReason: g('noGroups'),
        children: targets.map((f) => ({
          id: `move-${f.id}`,
          label: f.name,
          onSelect: () => moveItem(key, f.id),
        })),
      },
    ];
    if (current)
      entries.push({
        id: 'remove-from',
        label: g('removeFrom'),
        icon: FolderMinus,
        onSelect: () => moveItem(key, null),
      });
    return entries;
  };
  // Defer so the context menu finishes closing (and restoring focus) before
  // the inline input mounts; otherwise the restore blurs and commits it.
  const startEditing = (id: string, draft: string) =>
    window.setTimeout(() => setEditing({ id, draft }), 0);
  const commitRename = () => {
    if (!editing) return;
    const name = editing.draft.trim();
    if (name) renameFolder(editing.id, name);
    setEditing(null);
  };
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
          aria-expanded={groupCreatorOpen}
          aria-controls="collab-group-inline"
          onClick={onNewGroup}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {groupCreatorOpen ? (
        <div id="collab-group-inline">{groupCreator}</div>
      ) : null}
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
          {sections.map((section) => {
            if (!section.group) return section.items.map(renderRow);
            const folder = section.group;
            if (query && section.items.length === 0) return null;
            const isEditing = editing?.id === folder.id;
            return (
              <li
                key={`folder:${folder.id}`}
                className="collab-folder"
                data-testid={`collab-folder-${folder.id}`}
                data-collapsed={folder.collapsed}
              >
                <div
                  className="collab-folder-head"
                  onContextMenu={(event) =>
                    openMenu(event, [
                      {
                        id: 'rename',
                        label: g('rename'),
                        icon: Pencil,
                        onSelect: () => startEditing(folder.id, folder.name),
                      },
                      {
                        id: 'delete',
                        label: g('delete'),
                        icon: Trash2,
                        danger: true,
                        onSelect: () => deleteFolder(folder.id),
                      },
                    ])
                  }
                >
                  {isEditing ? (
                    <span className="collab-folder-toggle">
                      <ChevronRight
                        className="collab-folder-chevron"
                        aria-hidden="true"
                      />
                      <input
                        className="collab-folder-name-input"
                        aria-label={g('nameLabel')}
                        value={editing.draft}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) =>
                          setEditing({
                            id: folder.id,
                            draft: event.target.value,
                          })
                        }
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename();
                          if (event.key === 'Escape') setEditing(null);
                        }}
                      />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="collab-folder-toggle"
                      aria-expanded={!folder.collapsed}
                      aria-label={g(folder.collapsed ? 'expand' : 'collapse', {
                        name: folder.name,
                      })}
                      onClick={() => toggleCollapsed(folder.id)}
                    >
                      <ChevronRight
                        className="collab-folder-chevron"
                        aria-hidden="true"
                      />
                      <span className="collab-folder-name">{folder.name}</span>
                      <span className="collab-folder-count">
                        {section.items.length}
                      </span>
                    </button>
                  )}
                </div>
                {folder.collapsed ? null : (
                  <ul className="collab-folder-rows">
                    {section.items.map(renderRow)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {menu ? (
        <ProductContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </nav>
  );

  function renderRow(item: ThreadListItem): ReactNode {
    const selected = item.key === selectedKey;
    const name =
      item.kind === 'member' ? item.member.nickname : `#${item.group.name}`;
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
        onContextMenu={(event) => openMenu(event, rowMenu(item.key))}
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
                    .map((id) => avatarFor(id, nicknameById.get(id) ?? id))}
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
                    item.kind === 'member' ? item.presence.state : undefined
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
                  <Pin className="h-3 w-3" aria-label={THREAD_COPY.pin} />
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
  }
}
