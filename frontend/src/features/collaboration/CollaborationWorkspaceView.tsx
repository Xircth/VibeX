import { useMemo, type ReactNode } from 'react';
import { UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';

import {
  MigrationBanner,
  MigrationNoticeDialog,
  NewGroupDialog,
  NewMemberDialog,
  TeamTemplateEmptyState,
  type PickerMember,
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
  type ThreadFilter,
  type ThreadListItem,
  type ThreadMember,
  type TeamTemplate,
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

export type ProfileData = {
  activity: ProfileActivity[];
  facts: ProfileFact[];
  writeAccess: WriteAccess;
  agentLabel?: string;
};

export type CollaborationWorkspaceViewProps = {
  items: readonly ThreadListItem[];
  members: readonly ThreadMember[];
  selectedKey: string | null;
  filter: ThreadFilter;
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
  dialogs: { newGroup: boolean; newMember: boolean; migration: boolean };
  bannerVisible: boolean;
  busy?: boolean;
  workspacePath?: string;
  workspaceId?: string;
  error?: string | null;
  onFilterChange: (filter: ThreadFilter) => void;
  onQueryChange: (query: string) => void;
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
  onDialogChange: (
    dialog: 'newGroup' | 'newMember' | 'migration',
    open: boolean
  ) => void;
  onDismissBanner: () => void;
  onCreateGroup: (name: string, memberIds: string[]) => void;
  onCreateMember: (input: { roleId: string; nickname: string }) => void;
  onCreateTeam: (template: TeamTemplate) => void;
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
  onOpenSession: (conversationId: string) => void;
  onToggleProfile: (open: boolean) => void;
  onSelectMember: (memberId: string) => void;
  onUpdateFact: (factId: string, content: string) => void;
  onDeleteFact: (factId: string) => void;
  onSetWriteAccess: (value: WriteAccess) => void;
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
  if (items.length === 0 && !props.query && props.filter === 'all') {
    main = (
      <div className="collab-main">
        <TeamTemplateEmptyState
          busy={props.busy}
          onCreate={props.onCreateTeam}
        />
      </div>
    );
  } else if (selectedMember) {
    main = (
      <div className="collab-main" data-testid="collab-direct-chat">
        <header className="collab-main-head">
          <span className="collaboration-message-avatar">
            <MemberBotAvatar
              config={avatarFor(
                selectedMember.memberId,
                selectedMember.nickname
              )}
              className="h-6 w-6"
            />
          </span>
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
            directSeat?.conversationId
              ? () => props.onOpenSession(directSeat.conversationId ?? '')
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
        onSelectMember={props.onSelectMember}
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

  return (
    <div
      className="collab-ws"
      data-profile={profileOpen && selectedMember ? 'open' : 'closed'}
      data-testid="collab-workspace"
    >
      <ThreadList
        items={items}
        selectedKey={selectedKey}
        filter={props.filter}
        query={props.query}
        avatarFor={avatarFor}
        now={props.now}
        onFilterChange={props.onFilterChange}
        onQueryChange={props.onQueryChange}
        onSelect={props.onSelect}
        onTogglePin={props.onTogglePin}
        onNewGroup={() => props.onDialogChange('newGroup', true)}
        onNewMember={() => props.onDialogChange('newMember', true)}
        banner={
          props.bannerVisible ? (
            <MigrationBanner
              onMore={() => props.onDialogChange('migration', true)}
              onDismiss={props.onDismissBanner}
            />
          ) : null
        }
      />
      {main}
      {profileOpen && selectedMember && profile ? (
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
        />
      ) : null}
      {props.error ? (
        <p className="collaboration-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <NewGroupDialog
        open={props.dialogs.newGroup}
        members={pickerMembers}
        busy={props.busy}
        onOpenChange={(open) => props.onDialogChange('newGroup', open)}
        onCreate={props.onCreateGroup}
        onNewMember={() => props.onDialogChange('newMember', true)}
      />
      <NewMemberDialog
        key={props.roles.map((r) => r.id).join(',')}
        open={props.dialogs.newMember}
        roles={props.roles}
        busy={props.busy}
        onOpenChange={(open) => props.onDialogChange('newMember', open)}
        onCreate={props.onCreateMember}
      />
      <MigrationNoticeDialog
        open={props.dialogs.migration}
        onAcknowledge={() => props.onDialogChange('migration', false)}
      />
    </div>
  );
}
