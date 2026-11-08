import { memo, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import { Button } from '@/components/ui/button';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { ConversationSelectionToolbar } from '@/components/NormalizedConversation/ConversationSelectionToolbar';
import i18n from '@/i18n';
import {
  COPY,
  agentRoster,
  displayName,
  extractEnvelopeCrossChatMeta,
  formatRoundProgress,
  isCollaborationLimitNotice,
  isStreamingSpaceMessage,
  messageAuthor,
  receiptStatusCopy,
  resolveMessageConversationId,
  resolveMessageDeliveryStatus,
  resolveMessageReceipts,
  type CrossChatPeer,
  type SpaceMember,
} from '../spaceModel';
import {
  MemberBotAvatar,
  type MemberBotAvatarConfig,
} from '../MemberBotAvatar';
import {
  SpaceMessageBody,
  approvalCardToPermissionView,
  bubbleText,
} from '../SpaceMessageBody';
import { CollaborationWorkingStatus } from '../CollaborationWorkingStatus';
import { CollaborationCrossChatNotice } from '../CollaborationCrossChatNotice';
import { CollaborationThreadPermissionDock } from '../CollaborationThreadPermissionDock';
import { spaceMessageRefKey } from '../collaborationMessageNav';
import { isCollabThreadLogAtBottom } from '../collaborationThreadLog';
import { EMPTY_RECEIPTS } from './types';
import { reactionsFromUnknown } from '../spaceReactions';
import { showsClusterAvatar, showsClusterName } from '../messageCluster';
import { DirectMessages } from './DirectMessages';
import type { CollaborationSpaceRuntime } from './CollaborationSpaceRuntime';

import { useCollaborationSpacePick } from './SpaceContext';

type SpaceMessage = CollaborationSpaceRuntime['filteredMessages'][number];
type MessageClusterPosition =
  CollaborationSpaceRuntime['messageClusters'][number];
type SpaceDeliveryReceipt = NonNullable<
  CollaborationSpaceRuntime['receiptsBySeq'][number]
>[number];
type SpaceCardRecord = NonNullable<
  CollaborationSpaceRuntime['threadCards']
>[number];

const EMPTY_GROUP_AVATARS: readonly MemberBotAvatarConfig[] = [];

type CrossChatLookup = {
  memberAvatarFor: (peer: CrossChatPeer) => MemberBotAvatarConfig;
  groupAvatarsFor: (peer: CrossChatPeer) => readonly MemberBotAvatarConfig[];
};

const MESSAGE_NAV_PICK_KEYS = [
  'activeNavIndex',
  'navEntries',
  'scrollToMessage',
  'selected',
] as const;

const CollaborationMessageNavRail = memo(
  function CollaborationMessageNavRail() {
    const { activeNavIndex, navEntries, scrollToMessage, selected } =
      useCollaborationSpacePick(MESSAGE_NAV_PICK_KEYS);

    if (!selected || navEntries.length === 0) return null;

    return (
      <div className="conv-message-nav-anchor">
        <ConversationMessageNav
          entries={navEntries}
          activeIndex={activeNavIndex ?? navEntries.length - 1}
          onSelect={scrollToMessage}
        />
      </div>
    );
  }
);

type SpaceMessageRowProps = {
  message: SpaceMessage;
  cluster: MessageClusterPosition;
  selectedSpaceId: string;
  isPrivateChatActive: boolean;
  fromYouLabel: string;
  unknownMemberLabel: string;
  fallbackRosterColor: string;
  externalReceipts: SpaceDeliveryReceipt[] | undefined;
  authorConversationId: string;
  authorMember: SpaceMember;
  isAuthorLead: boolean;
  getMemberAvatar: (
    conversationId?: string,
    nickname?: string,
    identityMemberId?: string | null
  ) => MemberBotAvatarConfig;
  crossChatLookup: CrossChatLookup;
  receiptLabels: Record<string, string>;
  threadCards: SpaceCardRecord[] | undefined;
  workspacePath: string | undefined;
  workspaceId: string | undefined;
  messageItemRefs: MutableRefObject<Map<string, HTMLElement>>;
  openMessageBubbleMenu: (
    event: React.MouseEvent,
    message: SpaceMessage
  ) => void;
  openMemberAvatarMenu: (
    event: React.MouseEvent,
    member: SpaceMember,
    name: string,
    color: string,
    avatar: MemberBotAvatarConfig
  ) => void;
  selectMemberForPreview: (spaceId: string, member: SpaceMember) => void;
};

const SpaceMessageRow = memo(function SpaceMessageRow({
  message,
  cluster,
  selectedSpaceId,
  isPrivateChatActive,
  fromYouLabel,
  unknownMemberLabel,
  fallbackRosterColor,
  externalReceipts,
  authorConversationId,
  authorMember,
  isAuthorLead,
  getMemberAvatar,
  crossChatLookup,
  receiptLabels,
  threadCards,
  workspacePath,
  workspaceId,
  messageItemRefs,
  openMessageBubbleMenu,
  openMemberAvatarMenu,
  selectMemberForPreview,
}: SpaceMessageRowProps) {
  if (isCollaborationLimitNotice(message)) {
    return (
      <div
        className="collaboration-system-notice"
        data-testid="collaboration-limit-notice"
      >
        {COPY.collaborationLimitNotice}
      </div>
    );
  }
  const author = messageAuthor(message.envelope);
  const fromYou = author === COPY.you;
  const name = fromYou ? fromYouLabel : author || unknownMemberLabel;
  const messageReceipts = resolveMessageReceipts(
    message.envelope,
    (message.receipts && message.receipts.length > 0
      ? message.receipts
      : externalReceipts) ?? EMPTY_RECEIPTS
  );
  const roundProgress = !isPrivateChatActive
    ? formatRoundProgress(messageReceipts)
    : null;
  const failedReceipts = messageReceipts.filter(
    (receipt) =>
      receipt.state === 'failed' ||
      receipt.delivered === 'failed' ||
      (Boolean(receipt.error_code) &&
        receipt.state !== 'cancelled' &&
        receipt.state !== 'timed_out' &&
        receipt.state !== 'passed')
  );
  const outcomeReceipts = messageReceipts.filter((receipt) => {
    const state = String(receipt.state ?? '');
    return state === 'timed_out' || state === 'cancelled';
  });
  const statusReceipts = [
    ...failedReceipts,
    ...outcomeReceipts.filter(
      (receipt) =>
        !failedReceipts.some(
          (failed) =>
            (failed.conversation_id ?? failed.nickname) ===
            (receipt.conversation_id ?? receipt.nickname)
        )
    ),
  ];
  const deliveryStatus = fromYou
    ? resolveMessageDeliveryStatus(messageReceipts)
    : null;
  const envelopeCrossMeta = extractEnvelopeCrossChatMeta(message.envelope);
  const crossSentTargets = envelopeCrossMeta.sentTo;
  const crossReceivedSources = envelopeCrossMeta.receivedFrom;
  const textBody = bubbleText(message.envelope);
  const hasBody = textBody.trim().length > 0;
  if (
    !hasBody &&
    crossSentTargets.length === 0 &&
    crossReceivedSources.length === 0
  ) {
    return null;
  }
  const messageKey = spaceMessageRefKey(message);
  const showName = showsClusterName(cluster);
  const showAvatar = showsClusterAvatar(cluster);
  const avatar = getMemberAvatar(authorConversationId, name);
  const noticeLineColor =
    (crossReceivedSources[0]
      ? getMemberAvatar(undefined, crossReceivedSources[0].name).color
      : '') ||
    (!fromYou ? avatar.color : '') ||
    fallbackRosterColor ||
    'var(--text-muted)';
  const openAuthorPreview = () => {
    selectMemberForPreview(selectedSpaceId, authorMember);
  };
  const messageReactions = reactionsFromUnknown(message.envelope.reactions);

  return (
    <article
      ref={(node) => {
        if (node) {
          messageItemRefs.current.set(messageKey, node);
        } else {
          messageItemRefs.current.delete(messageKey);
        }
      }}
      className="collaboration-message"
      data-testid={`collaboration-message-${message.seq}`}
      data-cluster={cluster ?? undefined}
      onContextMenu={(event) => openMessageBubbleMenu(event, message)}
    >
      {hasBody && !fromYou ? (
        <div className="collaboration-message-row">
          <div className="collaboration-message-avatar-slot">
            {showAvatar ? (
              <button
                type="button"
                className="collaboration-message-avatar"
                aria-label={i18n.t('panels:ui.collabPage.previewNameSession', {
                  name: name,
                })}
                onClick={openAuthorPreview}
                onContextMenu={(event) =>
                  openMemberAvatarMenu(
                    event,
                    authorMember,
                    name,
                    avatar.color,
                    avatar
                  )
                }
              >
                <MemberBotAvatar
                  config={avatar}
                  animated={false}
                  sessionActive={false}
                  className="h-10 w-10"
                  lead={isAuthorLead}
                  data-testid={`collaboration-message-bot-avatar-${message.seq}`}
                />
              </button>
            ) : null}
          </div>
          <div className="collaboration-message-main">
            {showName ? (
              <p
                className="collaboration-message-name"
                style={{ color: avatar.color }}
              >
                {name}
              </p>
            ) : null}
            <SpaceMessageBody
              fromYou={fromYou}
              text={textBody}
              workspacePath={workspacePath}
              workspaceId={workspaceId}
              deliveryStatus={deliveryStatus}
              reactions={messageReactions}
              cards={threadCards}
              streaming={isStreamingSpaceMessage(message)}
            />
          </div>
        </div>
      ) : null}
      {hasBody && fromYou ? (
        <SpaceMessageBody
          fromYou={fromYou}
          text={textBody}
          workspacePath={workspacePath}
          workspaceId={workspaceId}
          deliveryStatus={deliveryStatus}
          reactions={messageReactions}
          cards={threadCards}
          streaming={isStreamingSpaceMessage(message)}
        />
      ) : null}
      <CollaborationCrossChatNotice
        kind="received"
        seq={message.seq}
        peers={crossReceivedSources}
        lineColor={noticeLineColor}
        memberAvatarFor={crossChatLookup.memberAvatarFor}
        groupAvatarsFor={crossChatLookup.groupAvatarsFor}
      />
      <CollaborationCrossChatNotice
        kind="sent"
        seq={message.seq}
        peers={crossSentTargets}
        lineColor={noticeLineColor}
        memberAvatarFor={crossChatLookup.memberAvatarFor}
        groupAvatarsFor={crossChatLookup.groupAvatarsFor}
      />
      {roundProgress || statusReceipts.length > 0 ? (
        <ul className="collaboration-receipts">
          {roundProgress ? (
            <li
              key={`round-progress-${message.seq}`}
              className="collaboration-receipt collaboration-round-progress"
              data-testid={`collaboration-round-progress-${message.seq}`}
              data-round-state={roundProgress.state}
            >
              <span>{roundProgress.label}</span>
            </li>
          ) : null}
          {statusReceipts.map((receipt, index) => {
            const status = receiptStatusCopy(receipt, receiptLabels);
            const statusKey = String(
              receipt.state ??
                (receipt.delivered === 'failed' ? 'failed' : 'queued')
            );
            return (
              <li
                key={
                  receipt.conversation_id ??
                  receipt.nickname ??
                  `${message.seq}-${index}`
                }
                className="collaboration-receipt"
                data-status={statusKey}
              >
                <span>
                  {receipt.nickname ? `${receipt.nickname} ${status}` : status}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
});

const MESSAGE_STREAM_PICK_KEYS = [
  'filteredMessages',
  'followThreadBottomRef',
  'getMemberAvatar',
  'handleAddSelectionToCollection',
  'handleQuoteSelection',
  'handleResolveApprovalCard',
  'ignoreThreadScrollRef',
  'isDefaultVirtualSpaceSelected',
  'isPrivateChatActive',
  'leadConversationIds',
  'markSpaceInReviewMembersViewed',
  'memberAvatars',
  'members',
  'membersBySpace',
  'messageClusters',
  'messageItemRefs',
  'navEntries',
  'openCreateMemberDialog',
  'openCreateSpaceDialog',
  'openMemberAvatarMenu',
  'openMessageBubbleMenu',
  'pendingApprovalCardIds',
  'pendingApprovalCards',
  'receiptLabels',
  'receiptsBySeq',
  'respondingApprovalCardId',
  'selectMemberForPreview',
  'selected',
  'setActiveNavIndex',
  'setIsAtThreadBottom',
  'spaces',
  't',
  'threadCards',
  'threadLogRef',
  'visibleRoster',
  'workingConversationIds',
  'workingMembers',
  'workspace',
  'workspacePath',
] as const;

export const MessageStream = memo(function MessageStream() {
  const {
    filteredMessages,
    followThreadBottomRef,
    getMemberAvatar,
    handleAddSelectionToCollection,
    handleQuoteSelection,
    ignoreThreadScrollRef,
    isDefaultVirtualSpaceSelected,
    isPrivateChatActive,
    leadConversationIds,
    markSpaceInReviewMembersViewed,
    members,
    membersBySpace,
    messageClusters,
    messageItemRefs,
    navEntries,
    openCreateMemberDialog,
    openCreateSpaceDialog,
    openMemberAvatarMenu,
    openMessageBubbleMenu,
    receiptLabels,
    receiptsBySeq,
    selectMemberForPreview,
    selected,
    setActiveNavIndex,
    setIsAtThreadBottom,
    spaces,
    t,
    threadCards,
    threadLogRef,
    visibleRoster,
    workingConversationIds,
    workingMembers,
    pendingApprovalCards,
    pendingApprovalCardIds,
    respondingApprovalCardId,
    handleResolveApprovalCard,
    workspace,
    workspacePath,
  } = useCollaborationSpacePick(MESSAGE_STREAM_PICK_KEYS);

  const navScrollRafRef = useRef<number | null>(null);
  const fallbackAuthorMembersRef = useRef<Map<string, SpaceMember>>(new Map());

  useEffect(() => {
    return () => {
      if (
        navScrollRafRef.current !== null &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(navScrollRafRef.current);
        navScrollRafRef.current = null;
      }
    };
  }, []);

  const memberLookup = useMemo(() => {
    const rosterByName = new Map<string, SpaceMember>();
    for (const item of visibleRoster) {
      const n = displayName(item);
      if (n && !rosterByName.has(n)) rosterByName.set(n, item);
    }
    const membersByConvId = new Map<string, SpaceMember>();
    const membersByName = new Map<string, SpaceMember>();
    for (const item of members) {
      if (item.conversation_id && !membersByConvId.has(item.conversation_id)) {
        membersByConvId.set(item.conversation_id, item);
      }
      const n = displayName(item);
      if (n && !membersByName.has(n)) membersByName.set(n, item);
    }
    return { rosterByName, membersByConvId, membersByName };
  }, [members, visibleRoster]);

  const crossChatLookup = useMemo<CrossChatLookup>(() => {
    const spaceIdByName = new Map<string, string>();
    for (const space of spaces) {
      if (space.name && !spaceIdByName.has(space.name)) {
        spaceIdByName.set(space.name, space.space_id);
      }
    }
    const groupAvatarsBySpaceId = new Map<
      string,
      readonly MemberBotAvatarConfig[]
    >();
    for (const [spaceId, rawMembers] of Object.entries(membersBySpace)) {
      groupAvatarsBySpaceId.set(
        spaceId,
        agentRoster(rawMembers ?? []).map((member) =>
          getMemberAvatar(
            member.conversation_id ?? undefined,
            displayName(member)
          )
        )
      );
    }
    return {
      memberAvatarFor: (peer: CrossChatPeer) =>
        getMemberAvatar(undefined, peer.name),
      groupAvatarsFor: (peer: CrossChatPeer) => {
        const spaceId = peer.id || spaceIdByName.get(peer.name);
        if (!spaceId) return EMPTY_GROUP_AVATARS;
        return groupAvatarsBySpaceId.get(spaceId) ?? EMPTY_GROUP_AVATARS;
      },
    };
  }, [getMemberAvatar, membersBySpace, spaces]);

  const fromYouLabel = t('collaborationSpace.you', COPY.you);
  const unknownMemberLabel = t('collaborationSpace.unknownMember', '未知成员');
  const fallbackRosterColor = visibleRoster[0]
    ? getMemberAvatar(
        visibleRoster[0].conversation_id ?? undefined,
        displayName(visibleRoster[0])
      ).color
    : '';

  return (
    <>
      <div
        ref={threadLogRef}
        className="collaboration-thread-log"
        onPointerDownCapture={() => {
          if (selected) {
            markSpaceInReviewMembersViewed(selected.space_id);
          }
        }}
        onWheelCapture={() => {
          if (selected) {
            markSpaceInReviewMembersViewed(selected.space_id);
          }
        }}
        onScroll={() => {
          if (selected) {
            markSpaceInReviewMembersViewed(selected.space_id);
          }
          const el = threadLogRef.current;
          if (!el || ignoreThreadScrollRef.current) return;
          const atBottom = isCollabThreadLogAtBottom(el);
          followThreadBottomRef.current = atBottom;
          setIsAtThreadBottom((current) =>
            current === atBottom ? current : atBottom
          );
          if (atBottom) {
            if (
              navScrollRafRef.current !== null &&
              typeof cancelAnimationFrame === 'function'
            ) {
              cancelAnimationFrame(navScrollRafRef.current);
              navScrollRafRef.current = null;
            }
            setActiveNavIndex((current) => (current === null ? current : null));
            return;
          }
          if (navEntries.length > 0) {
            const computeActiveNav = () => {
              navScrollRafRef.current = null;
              const currentEl = threadLogRef.current;
              if (!currentEl || ignoreThreadScrollRef.current) return;
              if (isCollabThreadLogAtBottom(currentEl)) {
                setActiveNavIndex((current) =>
                  current === null ? current : null
                );
                return;
              }
              const anchorY =
                currentEl.scrollTop + currentEl.clientHeight * 0.4;
              let nextActive = navEntries[0]!.index;
              for (const entry of navEntries) {
                const target = filteredMessages[entry.index];
                if (!target) continue;
                const node =
                  messageItemRefs.current.get(spaceMessageRefKey(target)) ??
                  messageItemRefs.current.get(String(target.seq));
                if (node && node.offsetTop <= anchorY) {
                  nextActive = entry.index;
                }
              }
              setActiveNavIndex((current) =>
                current === nextActive ? current : nextActive
              );
            };
            if (typeof requestAnimationFrame === 'function') {
              if (navScrollRafRef.current === null) {
                navScrollRafRef.current =
                  requestAnimationFrame(computeActiveNav);
              }
            } else {
              computeActiveNav();
            }
          }
        }}
        onKeyDownCapture={() => {
          if (selected) {
            markSpaceInReviewMembersViewed(selected.space_id);
          }
        }}
      >
        {isDefaultVirtualSpaceSelected ? (
          <div
            className="collaboration-default-space-empty"
            data-testid="collaboration-default-space-empty"
          >
            <div
              className="collaboration-empty-member-pill"
              data-testid="collaboration-empty-member-pill"
            >
              {i18n.t('panels:ui.collabPage.thisSpaceHasNoBots')}
            </div>
            <div className="collaboration-empty-member-actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => openCreateMemberDialog()}
              >
                {i18n.t('panels:ui.collabPage.addBot')}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={openCreateSpaceDialog}
              >
                {COPY.newSpaceButton}
              </Button>
            </div>
          </div>
        ) : selected && filteredMessages.length > 0 ? (
          filteredMessages.map((message, index) => {
            const messageKey = isCollaborationLimitNotice(message)
              ? `space-notice-${message.seq}`
              : spaceMessageRefKey(message);
            const author = messageAuthor(message.envelope);
            const fromYou = author === COPY.you;
            const name = fromYou ? fromYouLabel : author || unknownMemberLabel;
            const authorConversationId = resolveMessageConversationId(
              message.envelope,
              members
            );
            let authorMember =
              memberLookup.rosterByName.get(name) ??
              (authorConversationId
                ? memberLookup.membersByConvId.get(authorConversationId)
                : undefined) ??
              memberLookup.membersByName.get(name);
            if (!authorMember) {
              const fallbackKey = `${authorConversationId}:${name}`;
              authorMember = fallbackAuthorMembersRef.current.get(fallbackKey);
              if (!authorMember) {
                authorMember = {
                  kind: 'agent' as const,
                  nickname: name,
                  conversation_id: authorConversationId,
                };
                fallbackAuthorMembersRef.current.set(fallbackKey, authorMember);
              }
            }
            return (
              <SpaceMessageRow
                key={messageKey}
                message={message}
                cluster={messageClusters[index] ?? null}
                selectedSpaceId={selected.space_id}
                isPrivateChatActive={isPrivateChatActive}
                fromYouLabel={fromYouLabel}
                unknownMemberLabel={unknownMemberLabel}
                fallbackRosterColor={fallbackRosterColor}
                externalReceipts={receiptsBySeq[message.seq]}
                authorConversationId={authorConversationId}
                authorMember={authorMember}
                isAuthorLead={leadConversationIds.has(authorConversationId)}
                getMemberAvatar={getMemberAvatar}
                crossChatLookup={crossChatLookup}
                receiptLabels={receiptLabels}
                threadCards={threadCards}
                workspacePath={workspacePath}
                workspaceId={workspace || undefined}
                messageItemRefs={messageItemRefs}
                openMessageBubbleMenu={openMessageBubbleMenu}
                openMemberAvatarMenu={openMemberAvatarMenu}
                selectMemberForPreview={selectMemberForPreview}
              />
            );
          })
        ) : null}
        <DirectMessages />
        {selected ? (
          <CollaborationWorkingStatus members={workingMembers} />
        ) : null}
        {workingConversationIds.map((conversationId) => (
          <CollaborationThreadPermissionDock
            key={`permission-dock-${conversationId}`}
            conversationId={conversationId}
            excludePermissionIds={pendingApprovalCardIds}
          />
        ))}
        {pendingApprovalCards.length > 0 ? (
          <div
            className="collaboration-thread-permission-dock"
            data-testid="collaboration-thread-approval-dock"
          >
            {pendingApprovalCards.map((card) => (
              <PermissionRequestCard
                key={`approval-card-${card.id}`}
                request={approvalCardToPermissionView(card)}
                responding={respondingApprovalCardId === card.id}
                onRespond={(_permissionId, response) => {
                  void handleResolveApprovalCard(card.id, response);
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <ConversationSelectionToolbar
        rootRef={threadLogRef}
        onQuote={handleQuoteSelection}
        onAddToCollection={
          selected && !isDefaultVirtualSpaceSelected
            ? (selectedText) => {
                void handleAddSelectionToCollection(selectedText);
              }
            : undefined
        }
      />

      <CollaborationMessageNavRail />
    </>
  );
});
