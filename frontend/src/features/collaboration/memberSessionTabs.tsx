import { lazy, Suspense, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

import { GroupAvatar } from './GroupAvatar';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';

const SessionPreview = lazy(() =>
  import('@/components/kanban/KanbanSessionConversationView').then(
    (module) => ({ default: module.KanbanSessionConversationView })
  )
);

/**
 * A member's underlying session for one thread, opened from an avatar click.
 * Exactly one tab per (member, thread).
 */
export type MemberSessionTab = {
  key: string;
  memberId: string;
  memberName: string;
  memberAvatar: MemberBotAvatarConfig;
  threadId: string;
  conversationId: string;
  /** Present for group threads; absent for the member's direct chat. */
  group?: { name: string; avatars: readonly MemberBotAvatarConfig[] };
};

export function memberSessionTabKey(memberId: string, threadId: string) {
  return `${memberId}:${threadId}`;
}

/** Add the tab, or keep the existing one for the same (member, thread). */
export function upsertMemberSessionTab(
  tabs: readonly MemberSessionTab[],
  tab: MemberSessionTab
): MemberSessionTab[] {
  return tabs.some((t) => t.key === tab.key) ? [...tabs] : [...tabs, tab];
}

/** Build the tab for (member, thread) from the loaded thread model. */
export function buildMemberSessionTab(input: {
  memberId: string;
  threadId: string;
  conversationId: string;
  members: readonly { memberId: string; nickname: string }[];
  groups: readonly { spaceId: string; name: string; memberIds: readonly string[] }[];
  avatarFor: (memberId: string, nickname: string) => MemberBotAvatarConfig;
}): MemberSessionTab {
  const nicknameOf = (id: string) =>
    input.members.find((m) => m.memberId === id)?.nickname ?? id;
  const memberName = nicknameOf(input.memberId);
  const group = input.groups.find((g) => g.spaceId === input.threadId);
  return {
    key: memberSessionTabKey(input.memberId, input.threadId),
    memberId: input.memberId,
    memberName,
    memberAvatar: input.avatarFor(input.memberId, memberName),
    threadId: input.threadId,
    conversationId: input.conversationId,
    group: group
      ? {
          name: group.name,
          avatars: group.memberIds.map((id) =>
            input.avatarFor(id, nicknameOf(id))
          ),
        }
      : undefined,
  };
}

export function closeMemberSessionTab(
  tabs: readonly MemberSessionTab[],
  activeKey: string | null,
  key: string
): { tabs: MemberSessionTab[]; activeKey: string | null } {
  const index = tabs.findIndex((t) => t.key === key);
  const next = tabs.filter((t) => t.key !== key);
  if (activeKey !== key) return { tabs: next, activeKey };
  const fallback = next[Math.min(Math.max(index, 0), next.length - 1)];
  return { tabs: next, activeKey: fallback?.key ?? null };
}

/**
 * Tab title rule (provisional, pending design decision).
 * Direct: member avatar + member name.
 * Group: group avatar with a member badge, "群名 · 成员名".
 * To switch group tabs back to plain group avatar + group name, set
 * GROUP_TAB_SHOWS_MEMBER to false.
 */
export const GROUP_TAB_SHOWS_MEMBER = true;

export type SessionTabTitle =
  | { icon: 'member'; text: string }
  | { icon: 'group-with-member'; text: string }
  | { icon: 'group'; text: string };

export function sessionTabTitle(
  tab: Pick<MemberSessionTab, 'memberName' | 'group'>,
  groupShowsMember: boolean = GROUP_TAB_SHOWS_MEMBER
): SessionTabTitle {
  if (!tab.group) return { icon: 'member', text: tab.memberName };
  return groupShowsMember
    ? { icon: 'group-with-member', text: `${tab.group.name} · ${tab.memberName}` }
    : { icon: 'group', text: tab.group.name };
}

function TabIcon({ tab, title }: { tab: MemberSessionTab; title: SessionTabTitle }) {
  if (title.icon === 'member' || !tab.group) {
    return (
      <MemberBotAvatar
        config={tab.memberAvatar}
        animated={false}
        className="h-4 w-4"
      />
    );
  }
  return (
    <span className="collab-session-tab-group" data-icon={title.icon}>
      <GroupAvatar avatars={tab.group.avatars} className="h-4 w-4" />
      {title.icon === 'group-with-member' ? (
        <span
          className="collab-session-tab-badge"
          data-testid="collab-session-tab-badge"
        >
          <MemberBotAvatar
            config={tab.memberAvatar}
            animated={false}
            className="h-2.5 w-2.5"
          />
        </span>
      ) : null}
    </span>
  );
}

export function MemberSessionTabsPanel({
  tabs,
  activeKey,
  workspaceId,
  onActivate,
  onClose,
  renderSession,
}: {
  tabs: readonly MemberSessionTab[];
  activeKey: string | null;
  workspaceId?: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Test seam; defaults to the embedded session conversation view. */
  renderSession?: (tab: MemberSessionTab) => ReactNode;
}) {
  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0] ?? null;
  return (
    <aside className="collab-session-panel" data-testid="collab-session-panel">
      <div className="collab-session-tabs" role="tablist">
        {tabs.map((tab) => {
          const title = sessionTabTitle(tab);
          const selected = tab.key === active?.key;
          return (
            <div
              key={tab.key}
              className={cn('collab-session-tab', selected && 'is-active')}
              data-tab-key={tab.key}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="collab-session-tab-button collab-focusable"
                title={title.text}
                onClick={() => onActivate(tab.key)}
              >
                <TabIcon tab={tab} title={title} />
                <span className="collab-session-tab-title">{title.text}</span>
              </button>
              <button
                type="button"
                className="collab-session-tab-close collab-focusable"
                aria-label={`关闭 ${title.text}`}
                onClick={() => onClose(tab.key)}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="collab-session-body collaboration-preview-frame">
        {active ? (
          renderSession ? (
            renderSession(active)
          ) : workspaceId ? (
            <Suspense
              fallback={<p className="collaboration-preview-empty">加载中</p>}
            >
              <SessionPreview
                key={active.conversationId}
                workspaceId={workspaceId}
                sessionId={active.conversationId}
                interactive
                showSessionSelector={false}
                markViewed={false}
                embedded
                className="h-full"
                imagePreviewPresentation="dialog"
                conversationWidthMode="workspace"
              />
            </Suspense>
          ) : null
        ) : null}
      </div>
    </aside>
  );
}
