import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import i18n from '@/i18n';
import { COPY, displayName } from '../spaceModel';
import { MemberBotAvatar } from '../MemberBotAvatar';
import { buildMemberAvatarMenuItems } from '../memberAvatarMenu';
import { requestCollaborationPulseProposal } from '../collaborationPulseEvents';
import { spaceCollectionPreviewPanelId } from '../CollaborationSpaceCollectionPanel';
import { ScheduledMessages } from './ScheduledMessages';

import { memo, useState } from 'react';
import { useCollaborationSpacePick } from './SpaceContext';

const MEMBER_PANEL_PICK_KEYS = [
  'activeDirectThreadId',
  'activePreviewTabId',
  'conversationById',
  'getMemberAvatar',
  'hoveredDelayedMemberKey',
  'listAvatarOutline',
  'listAvatarStyle',
  'memberAvatars',
  'openAssistantDetailsTab',
  'openDelayedMemberPopover',
  'openPrivateChat',
  'openSpaceCollectionTab',
  'scheduleCloseDelayedMemberPopover',
  'scheduledMessages',
  'selectMemberForPreview',
  'selected',
  'setDraft',
  'setTopMemberBarExpanded',
  'topMemberBarExpanded',
  'visibleRoster',
  'workspace',
] as const;

export const MemberPanel = memo(function MemberPanel({
  variant = 'overlay',
}: {
  variant?: 'overlay' | 'header';
} = {}) {
  const isHeaderVariant = variant === 'header';
  const [seatMenu, setSeatMenu] = useState<{
    x: number;
    y: number;
    ariaLabel: string;
    items: ProductContextMenuItem[];
  } | null>(null);
  const {
    activeDirectThreadId,
    activePreviewTabId,
    conversationById,
    getMemberAvatar,
    hoveredDelayedMemberKey,
    listAvatarOutline,
    listAvatarStyle,
    openAssistantDetailsTab,
    openDelayedMemberPopover,
    openPrivateChat,
    openSpaceCollectionTab,
    scheduleCloseDelayedMemberPopover,
    scheduledMessages,
    selectMemberForPreview,
    selected,
    setDraft,
    setTopMemberBarExpanded,
    topMemberBarExpanded,
    visibleRoster,
    workspace,
  } = useCollaborationSpacePick(MEMBER_PANEL_PICK_KEYS);

  return (
    <>
      {selected && topMemberBarExpanded ? (
        <div
          className={cn(
            'collaboration-top-member-bar',
            isHeaderVariant && 'is-canvas-header nodrag nopan'
          )}
          data-testid="collaboration-top-member-bar"
        >
          <div
            className="collaboration-top-member-chrome"
            data-testid="collaboration-top-member-chrome"
          >
            <button
              type="button"
              className={cn(
                'collaboration-top-collection-btn',
                activePreviewTabId ===
                  spaceCollectionPreviewPanelId(
                    activeDirectThreadId || selected.space_id
                  ) && 'is-active'
              )}
              aria-label={
                activeDirectThreadId
                  ? COPY.assistantDetailsButton
                  : COPY.groupDetailsButton
              }
              title={
                activeDirectThreadId
                  ? COPY.assistantDetailsButton
                  : COPY.groupDetailsButton
              }
              data-testid="collaboration-open-collection-btn"
              onClick={() =>
                activeDirectThreadId
                  ? openAssistantDetailsTab()
                  : openSpaceCollectionTab(selected.space_id, selected.name)
              }
            >
              <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
            <span
              className="collaboration-top-member-collapsed-divider"
              aria-hidden="true"
            />
            <button
              type="button"
              className="collaboration-top-member-toggle"
              aria-label={i18n.t('panels:ui.collabPage.collapseBotList')}
              title={i18n.t('panels:ui.collabPage.collapseBotList')}
              onClick={() => setTopMemberBarExpanded(false)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="collaboration-top-member-scroll">
            {visibleRoster.map((member) => {
              const nick = displayName(member);
              const convId = member.conversation_id ?? '';
              const avatar = getMemberAvatar(convId, nick);
              const memberHoverKey = member.member_id ?? (convId || nick);
              const memberConv = convId
                ? conversationById.get(convId)
                : undefined;
              const memberSessionActive = Boolean(
                memberConv?.turn_in_flight ||
                  memberConv?.status === 'inprogress'
              );
              const memberScheduledMessages = scheduledMessages.filter(
                (item) => {
                  const status = item.status ?? 'scheduled';
                  const senderConv =
                    item.caller_id ?? item.sender_conversation_id;
                  const senderNick = item.nickname ?? item.sender_nickname;
                  return (
                    status === 'scheduled' &&
                    ((convId && senderConv === convId) ||
                      (nick && senderNick === nick))
                  );
                }
              );
              const hasDelayedMessages = memberScheduledMessages.length > 0;
              const isDelayedPopoverOpen =
                hasDelayedMessages &&
                hoveredDelayedMemberKey === memberHoverKey;
              return (
                <Popover key={memberHoverKey} open={isDelayedPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'collaboration-top-member-chip',
                        hasDelayedMessages && 'has-delayed-messages'
                      )}
                      aria-label={i18n.t(
                        'panels:ui.collabPage.openNickSession',
                        { nick: nick }
                      )}
                      data-testid={`top-member-filter-${nick}`}
                      data-has-delayed-messages={
                        hasDelayedMessages ? 'true' : 'false'
                      }
                      onMouseEnter={() => {
                        if (hasDelayedMessages) {
                          openDelayedMemberPopover(memberHoverKey);
                        }
                      }}
                      onMouseLeave={() => {
                        if (hasDelayedMessages) {
                          scheduleCloseDelayedMemberPopover();
                        }
                      }}
                      onFocus={() => {
                        if (hasDelayedMessages) {
                          openDelayedMemberPopover(memberHoverKey);
                        }
                      }}
                      onBlur={() => {
                        if (hasDelayedMessages) {
                          scheduleCloseDelayedMemberPopover();
                        }
                      }}
                      onClick={() =>
                        selectMemberForPreview(selected.space_id, member)
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const resolvedMemberId =
                          member.member_id?.trim() || convId || nick;
                        setSeatMenu({
                          x: event.clientX,
                          y: event.clientY,
                          ariaLabel: nick,
                          items: buildMemberAvatarMenuItems({
                            nickname: nick,
                            color: avatar.color,
                            avatar,
                            memberId: resolvedMemberId,
                            spaceId: selected.space_id,
                            spaceName: selected.name,
                            onMention: () => {
                              setDraft?.(
                                (prev) => `${prev ? `${prev} ` : ''}@${nick} `
                              );
                            },
                            onOpenPrivateChat: () => {
                              openPrivateChat?.(selected.space_id, member);
                            },
                            onOpenSession: () => {
                              selectMemberForPreview(selected.space_id, member);
                            },
                            onBindPulseTrigger: () => {
                              requestCollaborationPulseProposal(
                                activeDirectThreadId
                                  ? {
                                      kind: 'bot',
                                      memberId: resolvedMemberId,
                                      botName: nick,
                                      mode: 'event',
                                      workspaceId: workspace || null,
                                    }
                                  : {
                                      kind: 'group-seat',
                                      spaceId: selected.space_id,
                                      spaceName: selected.name,
                                      memberId: resolvedMemberId,
                                      nickname: nick,
                                      workspaceId: workspace || null,
                                    }
                              );
                            },
                          }),
                        });
                      }}
                    >
                      <span
                        className="collaboration-list-avatar"
                        style={listAvatarStyle}
                      >
                        <MemberBotAvatar
                          config={avatar}
                          sessionActive={memberSessionActive}
                          silhouetteOutline={listAvatarOutline}
                          className="h-full w-full"
                          data-testid={`collaboration-top-member-bot-avatar-${nick}`}
                        />
                      </span>
                      <span
                        className="collaboration-top-member-chip-name"
                        style={{ color: avatar.color }}
                      >
                        {nick}
                      </span>
                    </button>
                  </PopoverTrigger>
                  {hasDelayedMessages ? (
                    <ScheduledMessages
                      nick={nick}
                      memberHoverKey={memberHoverKey}
                      items={memberScheduledMessages}
                      memberId={member.member_id ?? convId ?? nick}
                      spaceId={selected.space_id}
                    />
                  ) : null}
                </Popover>
              );
            })}
          </div>
        </div>
      ) : null}

      {selected && !topMemberBarExpanded ? (
        <div
          className={cn(
            'collaboration-top-member-collapsed-bar',
            isHeaderVariant && 'is-canvas-header nodrag nopan'
          )}
          data-testid="collaboration-top-member-collapsed-bar"
        >
          <button
            type="button"
            className={cn(
              'collaboration-top-collection-btn is-collapsed-bar',
              activePreviewTabId ===
                spaceCollectionPreviewPanelId(
                  activeDirectThreadId || selected.space_id
                ) && 'is-active'
            )}
            aria-label={
              activeDirectThreadId
                ? COPY.assistantDetailsButton
                : COPY.groupDetailsButton
            }
            title={
              activeDirectThreadId
                ? COPY.assistantDetailsButton
                : COPY.groupDetailsButton
            }
            data-testid="collaboration-open-collection-btn"
            onClick={() =>
              activeDirectThreadId
                ? openAssistantDetailsTab()
                : openSpaceCollectionTab(selected.space_id, selected.name)
            }
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
          <span
            className="collaboration-top-member-collapsed-divider"
            aria-hidden="true"
          />
          <button
            type="button"
            className="collaboration-top-member-expand-trigger"
            aria-label={i18n.t('panels:ui.collabPage.expandBotList')}
            title={i18n.t('panels:ui.collabPage.expandBotList')}
            data-testid="collaboration-top-member-collapsed-stack"
            onClick={() => setTopMemberBarExpanded(true)}
          >
            {visibleRoster.length > 0 ? (
              <span
                className="collaboration-top-member-stack"
                data-testid="collaboration-top-member-stack"
              >
                {visibleRoster.slice(0, 5).map((member, idx) => {
                  const nick = displayName(member);
                  const convId = member.conversation_id ?? '';
                  return (
                    <span
                      key={member.member_id ?? convId ?? nick}
                      className="collaboration-top-member-stack-item"
                      style={{ zIndex: 10 - idx }}
                    >
                      <span
                        className="collaboration-list-avatar"
                        style={listAvatarStyle}
                      >
                        <MemberBotAvatar
                          config={getMemberAvatar(convId, nick)}
                          silhouetteOutline={listAvatarOutline}
                          className="h-full w-full"
                        />
                      </span>
                    </span>
                  );
                })}
                {visibleRoster.length > 5 ? (
                  <span className="collaboration-top-member-stack-item collaboration-top-member-stack-more tabular-nums">
                    +{visibleRoster.length - 5}
                  </span>
                ) : null}
              </span>
            ) : null}
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
      {seatMenu ? (
        <ProductContextMenu
          x={seatMenu.x}
          y={seatMenu.y}
          items={seatMenu.items}
          onClose={() => setSeatMenu(null)}
          ariaLabel={seatMenu.ariaLabel}
        />
      ) : null}
    </>
  );
});
