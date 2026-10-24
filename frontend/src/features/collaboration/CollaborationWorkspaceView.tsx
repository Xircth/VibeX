import { useMemo, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';

import {
  NewMemberDialog,
  type PickerMember,
  type AgentOption,
  type NewMemberInput,
  type RoleTemplate,
} from './CollaborationDialogs';
import { GroupChat, type GroupMessage, type GroupSeat } from './GroupChat';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  DirectComposer,
  MemberDirectChatLog,
  type DirectChatTurn,
} from './MemberDirectChat';
import {
  MemberProfilePanel,
  type ProfileActivity,
  type ProfileFact,
  type WriteAccess,
} from './MemberProfilePanel';
import { ThreadList } from './ThreadList';
import { ApprovalCard, AskCard, type CardResolution } from './ThreadCards';
import {
  THREAD_COPY,
  type DirectChatNotice,
  type ThreadListItem,
  type ThreadMember,
} from './threadModel';

import './collaboration.css';
import './collaboration-threads.css';

export type PendingCard = {
  id: string;
  member_id?: string | null;
  space_id: string;
  kind: string;
  status: string;
  payload?: Record<string, unknown>;
  resolution?: Record<string, unknown> | null;
};

import { InlineGroupCreator } from './InlineGroupCreator';
import {
  MemberSessionTabsPanel,
  type MemberSessionTab,
} from './memberSessionTabs';
import type { MemberSessionConfig } from './MemberSessionConfigSection';

export type ProfileData = {
  activity: ProfileActivity[];
  facts: ProfileFact[];
  writeAccess: WriteAccess;
  agentLabel?: string;
  sessionConfig?: MemberSessionConfig | null;
};

export type CollaborationWorkspaceViewProps = {
  items: readonly ThreadListItem[];
  allItems?: readonly ThreadListItem[];
  members: readonly ThreadMember[];
  selectedKey: string | null;
  query: string;
  avatarFor: (memberId: string, nickname: string) => MemberBotAvatarConfig;
  now?: number;
  /** Direct chat with the selected member. */
  directTurns: readonly DirectChatTurn[];
  /** Cross-DM notice lines for the selected member's direct chat. */
  directNotices?: readonly DirectChatNotice[];
  directReceipts: Readonly<
    Record<string, import('./threadModel').ReceiptState>
  >;
  directExpandedKeys?: readonly string[];
  directSending?: boolean;
  /** Group chat. */
  groupSeats: readonly GroupSeat[];
  groupMessages: readonly GroupMessage[];
  groupInitial?: {
    draft?: string;
    wakePreview?: { willWake: number; asleep: number } | null;
    mentionOpen?: boolean;
  };
  cards: readonly PendingCard[];
  cardStatus: Readonly<Record<string, CardResolution>>;
  busyCardIds?: ReadonlySet<string>;
  profileOpen: boolean;
  profile: ProfileData | null;
  threadNames: ReadonlyMap<string, string>;
  roles: readonly RoleTemplate[];
  agents: readonly AgentOption[];
  dialogs: { newGroup: boolean; newMember: boolean };
  busy?: boolean;
  workspacePath?: string;
  workspaceId?: string;
  error?: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
  onDialogChange: (
    dialog: 'newGroup' | 'newMember',
    open: boolean
  ) => void;
  onCreateGroup: (name: string, memberIds: string[]) => void;
  onCreateMember: (input: NewMemberInput) => void;
  onSendDirect: (content: string) => void;
  onSendGroup: (content: string, to: string[]) => Promise<void> | void;
  onPreviewWake: (
    content: string
  ) => Promise<{ willWake: number; asleep: number }>;
  onResolveCard: (
    cardId: string,
    decision: 'allow_once' | 'allow_always' | 'deny',
    answer?: string
  ) => void;
  onToggleProfile: (open: boolean) => void;
  /** Avatar click inside a chat: open that member's session for this thread. */
  onOpenMemberSession: (memberId: string, threadId: string) => void;
  sessionTabs?: readonly MemberSessionTab[];
  activeSessionTabKey?: string | null;
  onActivateSessionTab?: (key: string) => void;
  onCloseSessionTab?: (key: string) => void;
  onUpdateFact: (factId: string, content: string) => void;
  onDeleteFact: (factId: string) => void;
  onSetWriteAccess: (value: WriteAccess) => void;
  onSaveSessionConfig?: (next: {
    agentId: string;
    modeId?: string;
    configValues: Record<string, string>;
    personaPrompt?: string;
  }) => void;
};

function cardView(card: PendingCard) {
  const payload = card.payload ?? {};
  if (card.kind === 'ask') {
    const options = Array.isArray(payload.options)
      ? payload.options.map(String)
      : [];
    return {
      kind: 'ask' as const,
      id: card.id,
      question: String(payload.question ?? ''),
      options,
    };
  }
  return {
    kind: 'approval' as const,
    id: card.id,
    action: String(payload.action ?? ''),
    command: String(payload.command ?? ''),
    reason: String(payload.reason ?? ''),
  };
}

export function CollaborationWorkspaceView(
  props: CollaborationWorkspaceViewProps
) {
  const { items, members, selectedKey, avatarFor, profileOpen, profile } =
    props;
  const selectedItem = items.find((item) => item.key === selectedKey) ?? null;
  const selectedMember =
    selectedItem?.kind === 'member'
      ? selectedItem.member
      : selectedKey?.startsWith('member:')
        ? (members.find((m) => `member:${m.memberId}` === selectedKey) ?? null)
        : null;
  const selectedGroup =
    selectedItem?.kind === 'group' ? selectedItem.group : null;
  const memberItem = selectedItem?.kind === 'member' ? selectedItem : null;
  const directComposerMembers = useMemo(
    () =>
      members.map((member) => ({
        id: member.memberId,
        nickname: member.nickname,
        avatar: avatarFor(member.memberId, member.nickname),
      })),
    [avatarFor, members]
  );
  const directSeat = selectedMember?.seats.find((seat) => seat.direct) ?? null;
  const pickerMembers: PickerMember[] = useMemo(
    () =>
      items
        .filter(
          (item): item is Extract<ThreadListItem, { kind: 'member' }> =>
            item.kind === 'member'
        )
        .map((item) => ({
          memberId: item.member.memberId,
          nickname: item.member.nickname,
          avatar: avatarFor(item.member.memberId, item.member.nickname),
          presence: item.presence,
        })),
    [avatarFor, items]
  );
  const memberCards = props.cards.filter(
    (card) =>
      selectedMember &&
      card.member_id === selectedMember.memberId &&
      card.status === 'pending' &&
      card.space_id === directSeat?.threadId
  );
  const resolveProps = {
    busyCardIds: props.busyCardIds,
    cardStatus: props.cardStatus,
  };
  const inlineCards = memberCards.map((card) => {
    const view = cardView(card);
    return view.kind === 'ask' ? (
      <AskCard
        key={card.id}
        card={view}
        from={selectedMember?.nickname}
        resolution={resolveProps.cardStatus[card.id]}
        busy={resolveProps.busyCardIds?.has(card.id)}
        onAnswer={(answer) =>
          props.onResolveCard(card.id, 'allow_once', answer)
        }
      />
    ) : (
      <ApprovalCard
        key={card.id}
        card={view}
        from={selectedMember?.nickname}
        resolution={resolveProps.cardStatus[card.id]}
        busy={resolveProps.busyCardIds?.has(card.id)}
        scope="direct"
        onResolve={(decision) => props.onResolveCard(card.id, decision)}
      />
    );
  });
  const directTurns = props.directTurns;

  const otherBusy =
    memberItem && memberItem.presence.state === 'busy'
      ? memberItem.presence.busyThreads.filter(Boolean)
      : [];

  let main: ReactNode;
  if (selectedMember) {
    main = (
      <div className="collab-main" data-testid="collab-direct-chat">
        <header className="collab-main-head">
          <button
            type="button"
            className="collaboration-message-avatar collab-main-head-avatar collab-focusable"
            aria-label={selectedMember.nickname}
            data-testid="collab-direct-avatar"
            disabled={!directSeat}
            onClick={() =>
              directSeat &&
              props.onOpenMemberSession(
                selectedMember.memberId,
                directSeat.threadId
              )
            }
          >
            <MemberBotAvatar
              config={avatarFor(
                selectedMember.memberId,
                selectedMember.nickname
              )}
              className="h-6 w-6"
            />
          </button>
          <div className="collab-main-head-text">
            <h3 className="collab-main-title">{selectedMember.nickname}</h3>
            <p className="collab-main-subtitle">
              {otherBusy.length > 0
                ? `${THREAD_COPY.busy(otherBusy[0])}（${THREAD_COPY.directUnaffected}）`
                : (memberItem?.presence.line ?? THREAD_COPY.idle)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={profileOpen}
            onClick={() => props.onToggleProfile(!profileOpen)}
          >
            <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            资料
          </Button>
        </header>
        <MemberDirectChatLog
          turns={directTurns}
          receipts={props.directReceipts}
          memberName={selectedMember.nickname}
          avatar={
            <MemberBotAvatar
              config={avatarFor(
                selectedMember.memberId,
                selectedMember.nickname
              )}
              animated={false}
              className="h-6 w-6"
            />
          }
          workspacePath={props.workspacePath}
          workspaceId={props.workspaceId}
          expandedKeys={props.directExpandedKeys}
          onOpenSession={
            directSeat
              ? () =>
                  props.onOpenMemberSession(
                    selectedMember.memberId,
                    directSeat.threadId
                  )
              : undefined
          }
          inlineCards={inlineCards}
          notices={props.directNotices}
          mentionCandidates={directComposerMembers.map((member) => ({
            nickname: member.nickname,
            avatar: member.avatar,
          }))}
        />
        <DirectComposer
          memberName={selectedMember.nickname}
          sending={props.directSending}
          onSend={props.onSendDirect}
          members={directComposerMembers}
          workspaceId={props.workspaceId}
          workspacePath={props.workspacePath}
        />
      </div>
    );
  } else if (selectedGroup) {
    main = (
      <GroupChat
        key={selectedGroup.spaceId}
        groupName={selectedGroup.name}
        seats={props.groupSeats}
        messages={props.groupMessages}
        cardStatus={props.cardStatus}
        busyCardIds={props.busyCardIds}
        workspacePath={props.workspacePath}
        workspaceId={props.workspaceId}
        initialDraft={props.groupInitial?.draft}
        initialWakePreview={props.groupInitial?.wakePreview}
        initialMentionOpen={props.groupInitial?.mentionOpen}
        onSend={props.onSendGroup}
        onPreviewWake={props.onPreviewWake}
        onResolveCard={props.onResolveCard}
        onSelectMember={(memberId) =>
          props.onOpenMemberSession(memberId, selectedGroup.spaceId)
        }
      />
    );
  } else {
    main = (
      <div className="collab-main">
        <div className="collaboration-empty-stage">
          <p className="collab-empty-hint">{THREAD_COPY.emptyList}</p>
        </div>
      </div>
    );
  }

  const showProfile = Boolean(profileOpen && selectedMember && profile);
  const sessionTabs = props.sessionTabs ?? [];
  const showSessions = !showProfile && sessionTabs.length > 0;

  return (
    <div
      className="collab-ws"
      data-profile={showProfile || showSessions ? 'open' : 'closed'}
      data-testid="collab-workspace"
    >
      <ThreadList
        items={items}
        selectedKey={selectedKey}
        query={props.query}
        avatarFor={avatarFor}
        now={props.now}
        onQueryChange={props.onQueryChange}
        searchItems={props.allItems}
        onSelect={props.onSelect}
        onTogglePin={props.onTogglePin}
        onNewGroup={() =>
          props.onDialogChange('newGroup', !props.dialogs.newGroup)
        }
        groupCreatorOpen={props.dialogs.newGroup}
        groupCreator={
          <InlineGroupCreator
            members={pickerMembers}
            busy={props.busy}
            onCreate={props.onCreateGroup}
          />
        }
        onNewMember={() => props.onDialogChange('newMember', true)}
      />
      {main}
      {showSessions ? (
        <MemberSessionTabsPanel
          tabs={sessionTabs}
          activeKey={props.activeSessionTabKey ?? null}
          workspaceId={props.workspaceId}
          onActivate={(key) => props.onActivateSessionTab?.(key)}
          onClose={(key) => props.onCloseSessionTab?.(key)}
        />
      ) : null}
      {showProfile && selectedMember && profile ? (
        <MemberProfilePanel
          nickname={selectedMember.nickname}
          avatar={avatarFor(selectedMember.memberId, selectedMember.nickname)}
          agentLabel={profile.agentLabel}
          presence={
            memberItem?.presence ?? {
              state: 'idle',
              line: null,
              busyThreads: [],
              queued: 0,
            }
          }
          groups={selectedMember.seats
            .filter((seat) => !seat.direct)
            .map((seat) => ({
              spaceId: seat.threadId,
              name: seat.threadName,
              busy: Boolean(
                memberItem?.presence.busyThreads.includes(seat.threadName)
              ),
            }))}
          activity={profile.activity}
          facts={profile.facts}
          writeAccess={profile.writeAccess}
          threadNames={props.threadNames}
          onClose={() => props.onToggleProfile(false)}
          onOpenGroup={(spaceId) => props.onSelect(`group:${spaceId}`)}
          onUpdateFact={props.onUpdateFact}
          onDeleteFact={props.onDeleteFact}
          onSetWriteAccess={props.onSetWriteAccess}
          sessionConfig={profile.sessionConfig}
          agents={props.agents}
          onSaveSessionConfig={props.onSaveSessionConfig}
        />
      ) : null}
      {props.error ? (
        <p className="collaboration-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <NewMemberDialog
        key={`${props.roles.map((r) => r.id).join(',')}|${props.agents
          .map((a) => a.agent_id)
          .join(',')}`}
        open={props.dialogs.newMember}
        roles={props.roles}
        agents={props.agents}
        busy={props.busy}
        onOpenChange={(open) => props.onDialogChange('newMember', open)}
        onCreate={props.onCreateMember}
      />
    </div>
  );
}
