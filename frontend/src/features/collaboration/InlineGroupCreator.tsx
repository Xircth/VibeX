import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SessionListSearchControl } from '@/components/workspace-session-list/SessionListSearchControl';
import { cn } from '@/lib/utils';

import { MemberBotAvatar } from './MemberBotAvatar';
import type { PickerMember } from './CollaborationDialogs';
import { THREAD_COPY } from './threadModel';

export const INLINE_GROUP_COPY = {
  search: '搜索成员',
  empty: '还没有可以拉进群的成员',
  noMatch: '没有匹配的成员',
  create: '创建群聊',
  minHint: '至少选择 2 位成员',
} as const;

export const MIN_GROUP_MEMBERS = 2;

/** Default group name derived from the selected members (no name form). */
export function defaultGroupName(nicknames: readonly string[]): string {
  return nicknames.join('、');
}

/**
 * Inline member picker shown under the 「创建群聊」 button: search box,
 * scrollable checkbox list (max height), and a create button that stays
 * disabled until at least two members are selected. No modal, no form.
 */
export function InlineGroupCreator({
  members,
  busy,
  onCreate,
}: {
  members: readonly PickerMember[];
  busy?: boolean;
  onCreate: (name: string, memberIds: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? members.filter((m) => m.nickname.toLowerCase().includes(needle))
      : members;
  }, [members, query]);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    );
  const [searchExpanded, setSearchExpanded] = useState(true);
  const canCreate = !busy && selected.length >= MIN_GROUP_MEMBERS;
  return (
    <div className="collab-group-inline" data-testid="collab-group-inline">
      <SessionListSearchControl
        searchQuery={query}
        isExpanded={searchExpanded}
        searchLabel={INLINE_GROUP_COPY.search}
        placeholder={INLINE_GROUP_COPY.search}
        onSearchQueryChange={setQuery}
        onExpandedChange={(expanded) =>
          setSearchExpanded(expanded || query.length > 0)
        }
      />
      <div
        className="collaboration-dialog-member-picker collab-group-picker collab-group-inline-list"
        role="group"
        aria-label={INLINE_GROUP_COPY.search}
      >
        {visible.length === 0 ? (
          <p className="collab-empty-hint">
            {members.length === 0
              ? INLINE_GROUP_COPY.empty
              : INLINE_GROUP_COPY.noMatch}
          </p>
        ) : (
          visible.map((member) => {
            const checked = selected.includes(member.memberId);
            return (
              <div
                key={member.memberId}
                className="collaboration-picker-row flex items-center gap-2"
              >
                <Checkbox
                  className="collab-picker-checkbox"
                  aria-label={member.nickname}
                  checked={checked}
                  onCheckedChange={() => toggle(member.memberId)}
                />
                <button
                  type="button"
                  className={cn(
                    'workspace-session-row-main collaboration-member-row flex-1 min-w-0',
                    checked && 'is-selected'
                  )}
                  onClick={() => toggle(member.memberId)}
                >
                  <span className="workspace-session-icon" aria-hidden="true">
                    <MemberBotAvatar
                      config={member.avatar}
                      animated={false}
                      className="h-7 w-7"
                    />
                  </span>
                  <span className="collaboration-member-title-group">
                    <span className="collaboration-member-name">
                      {member.nickname}
                    </span>
                    <span className="collaboration-member-subtitle">
                      {member.presence.line ?? THREAD_COPY.idle}
                    </span>
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
      <Button
        type="button"
        size="sm"
        className="collab-group-inline-create"
        disabled={!canCreate}
        title={canCreate ? undefined : INLINE_GROUP_COPY.minHint}
        onClick={() => {
          const names = selected
            .map((id) => members.find((m) => m.memberId === id)?.nickname)
            .filter((name): name is string => Boolean(name));
          onCreate(defaultGroupName(names), [...selected]);
          setSelected([]);
          setQuery('');
        }}
      >
        {INLINE_GROUP_COPY.create}
      </Button>
    </div>
  );
}
