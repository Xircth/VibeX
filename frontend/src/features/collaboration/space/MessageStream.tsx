import { useMemo } from 'react';
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
  type SpaceMember,
} from '../spaceModel';
import { MemberBotAvatar } from '../MemberBotAvatar';
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

import { useCollaborationSpace } from './SpaceContext';

export function MessageStream() {
  const {
    activeNavIndex,
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
    scrollToMessage,
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
  } = useCollaborationSpace();

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
            setActiveNavIndex((current) => (current === null ? current : null));
            return;
          }
          if (navEntries.length > 0) {
            const anchorY = el.scrollTop + el.clientHeight * 0.4;
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
            if (isCollaborationLimitNotice(message)) {
              return (
                <div
                  key={`space-notice-${message.seq}`}
                  className="collaboration-system-notice"
                  data-testid="collaboration-limit-notice"
                >
                  {COPY.collaborationLimitNotice}
                </div>
              );
            }
            const author = messageAuthor(message.envelope);
            const fromYou = author === COPY.you;
            const name = fromYou
              ? t('collaborationSpace.you', COPY.you)
              : author || t('collaborationSpace.unknownMember', '未知成员');
            const authorConversationId = resolveMessageConversationId(
              message.envelope,
              members
            );
            const messageReceipts = resolveMessageReceipts(
              message.envelope,
              (message.receipts && message.receipts.length > 0
                ? message.receipts
                : receiptsBySeq[message.seq]) ?? EMPTY_RECEIPTS
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
            const envelopeCrossMeta = extractEnvelopeCrossChatMeta(
              message.envelope
            );
            const crossSentTargets = envelopeCrossMeta.sentTo;
            const crossReceivedSources = envelopeCrossMeta.receivedFrom;
            const hasBody = bubbleText(message.envelope).trim().length > 0;
            if (
              !hasBody &&
              crossSentTargets.length === 0 &&
              crossReceivedSources.length === 0
            ) {
              return null;
            }
            const messageKey = spaceMessageRefKey(message);
            const cluster = messageClusters[index] ?? null;
            const showName = showsClusterName(cluster);
            const showAvatar = showsClusterAvatar(cluster);
            const avatar = getMemberAvatar(authorConversationId, name);
            const noticeLineColor =
              (crossReceivedSources[0]
                ? getMemberAvatar(undefined, crossReceivedSources[0].name).color
                : '') ||
              (!fromYou ? avatar.color : '') ||
              (visibleRoster[0]
                ? getMemberAvatar(
                    visibleRoster[0].conversation_id ?? undefined,
                    displayName(visibleRoster[0])
                  ).color
                : '') ||
              'var(--text-muted)';
            const authorMember = memberLookup.rosterByName.get(name) ??
              (authorConversationId
                ? memberLookup.membersByConvId.get(authorConversationId)
                : undefined) ??
              memberLookup.membersByName.get(name) ?? {
                kind: 'agent' as const,
                nickname: name,
                conversation_id: authorConversationId,
              };
            const openAuthorPreview = () => {
              selectMemberForPreview(selected.space_id, authorMember);
            };
            const messageReactions = reactionsFromUnknown(
              message.envelope.reactions
            );
            return (
              <article
                key={messageKey}
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
                          aria-label={i18n.t(
                            'panels:ui.collabPage.previewNameSession',
                            { name: name }
                          )}
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
                            lead={leadConversationIds.has(authorConversationId)}
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
                        text={bubbleText(message.envelope)}
                        workspacePath={workspacePath}
                        workspaceId={workspace || undefined}
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
                    text={bubbleText(message.envelope)}
                    workspacePath={workspacePath}
                    workspaceId={workspace || undefined}
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
                  memberAvatarFor={(peer) =>
                    getMemberAvatar(undefined, peer.name)
                  }
                  groupAvatarsFor={(peer) => {
                    const spaceId =
                      peer.id ||
                      spaces.find((space) => space.name === peer.name)
                        ?.space_id;
                    return agentRoster(
                      spaceId ? (membersBySpace[spaceId] ?? []) : []
                    ).map((member) =>
                      getMemberAvatar(
                        member.conversation_id ?? undefined,
                        displayName(member)
                      )
                    );
                  }}
                />
                <CollaborationCrossChatNotice
                  kind="sent"
                  seq={message.seq}
                  peers={crossSentTargets}
                  lineColor={noticeLineColor}
                  memberAvatarFor={(peer) =>
                    getMemberAvatar(undefined, peer.name)
                  }
                  groupAvatarsFor={(peer) => {
                    const spaceId =
                      peer.id ||
                      spaces.find((space) => space.name === peer.name)
                        ?.space_id;
                    return agentRoster(
                      spaceId ? (membersBySpace[spaceId] ?? []) : []
                    ).map((member) =>
                      getMemberAvatar(
                        member.conversation_id ?? undefined,
                        displayName(member)
                      )
                    );
                  }}
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
                            {receipt.nickname
                              ? `${receipt.nickname} ${status}`
                              : status}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </article>
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

      {selected && navEntries.length > 0 ? (
        <div className="conv-message-nav-anchor">
          <ConversationMessageNav
            entries={navEntries}
            activeIndex={activeNavIndex ?? navEntries.length - 1}
            onSelect={scrollToMessage}
          />
        </div>
      ) : null}
    </>
  );
}
