import { Badge } from '@astryxdesign/core/Badge';
import { AtSign, Paperclip } from 'lucide-react';
import { getAgentName } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ActionBarUtilityButtons } from '@/components/tasks/follow-up/ActionBarUtilityButtons';
import { ComposerPrimaryActionButton } from '@/components/tasks/follow-up/ComposerPrimaryActionButton';
import { MessageQueueIndicator } from '@/components/tasks/follow-up/MessageQueueIndicator';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from '@/components/tasks/follow-up/SessionComposerInput';
import i18n from '@/i18n';
import { COPY, displayName } from '../spaceModel';
import { MemberBotAvatar, deriveMemberBotAvatar } from '../MemberBotAvatar';
import { GroupAvatar } from '../GroupAvatar';
import { CollaborationReplyCapsule } from '../CollaborationReplyCapsule';

import { useCollaborationSpace } from './SpaceContext';

export function ComposerDock() {
  const {
    activeDirectThreadId,
    attachedImages,
    composerContainerRef,
    composerFileInputRef,
    composerMembersMenuOpen,
    conversationById,
    draft,
    draftMemberMetaByConvId,
    getMemberAvatar,
    handleAttachFiles,
    handleComposerFileSelect,
    handleDelaySpaceQueuedMessage,
    handleDeleteSpaceQueuedMessage,
    handleEditSpaceQueuedMessage,
    handleEnhancePrompt,
    handleRemoveAttachedImage,
    handleTriggerAtMember,
    isBotSessionLoading,
    isEnhancingPrompt,
    isPrivateChatActive,
    openComposerMembersMenu,
    promptEnhancementEnabled,
    replaceDraftRef,
    replyingTo,
    repoIds,
    scheduleCloseComposerMembersMenu,
    selectMemberForPreview,
    selected,
    selectedTagPreset,
    send,
    sending,
    setComposerMembersMenuOpen,
    setDraft,
    setReplyingTo,
    spaceMemberRefs,
    spaceQueuedMessages,
    t,
    userDelayedSpaceMessages,
    visibleRoster,
    workspace,
    workspacePath,
  } = useCollaborationSpace();

  const showBotSessionLoadingNotice = Boolean(
    isPrivateChatActive && isBotSessionLoading
  );
  const composerDisabled = sending || showBotSessionLoadingNotice;

  return (
    <>
      {selected ? (
        <div ref={composerContainerRef} className="collaboration-composer-wrap">
          <MessageQueueIndicator
            queuedMessages={spaceQueuedMessages}
            delayedMessages={userDelayedSpaceMessages}
            onEditQueuedMessage={handleEditSpaceQueuedMessage}
            onDeleteQueuedMessage={(message) => {
              void handleDeleteSpaceQueuedMessage(message);
            }}
            onDelayQueuedMessage={
              // delaySeconds is not supported for private chats.
              activeDirectThreadId
                ? undefined
                : (message, delaySeconds) => {
                    void handleDelaySpaceQueuedMessage(message, delaySeconds);
                  }
            }
          />
          <SessionComposerFrame
            status={
              showBotSessionLoadingNotice ? (
                <div
                  className="conversation-status-dock"
                  data-testid="conversation-status-dock"
                  data-placement="composer"
                  aria-live="polite"
                >
                  <div className="composer-status-surface rounded-lg">
                    <div
                      className="composer-status-row text-xs"
                      data-tone="info"
                      role="status"
                    >
                      <div className="composer-status-header">
                        <div className="composer-status-heading">
                          <p className="composer-status-title text-foreground">
                            正在加载Bot会话...
                          </p>
                          <Badge
                            className="composer-status-badge"
                            variant="info"
                            label={t(
                              'conversation:statusDock.infoBadge',
                              'Notice'
                            )}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null
            }
            drawer={
              <SessionComposerAttachmentDrawer
                images={attachedImages}
                disabled={sending}
                taskAttemptId={workspace || undefined}
                onRemoveImage={handleRemoveAttachedImage}
              />
            }
          >
            <div className="composer-topbar flex items-center justify-between gap-2 px-1 pb-0 text-xs">
              <div
                className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground"
                data-testid="composer-current-space"
              >
                {activeDirectThreadId ? (
                  <MemberBotAvatar
                    config={
                      visibleRoster[0]
                        ? getMemberAvatar(
                            visibleRoster[0].conversation_id ?? undefined,
                            displayName(visibleRoster[0])
                          )
                        : deriveMemberBotAvatar(selected.name)
                    }
                    animated={false}
                    className="h-4 w-4 shrink-0"
                  />
                ) : (
                  <GroupAvatar
                    avatars={visibleRoster.map((member) =>
                      getMemberAvatar(
                        member.conversation_id ?? undefined,
                        displayName(member)
                      )
                    )}
                    tagHue={selectedTagPreset?.hue}
                    size={18}
                  />
                )}
                <span className="truncate">{selected.name}</span>
              </div>

              {activeDirectThreadId ? null : (
                <Popover
                  open={composerMembersMenuOpen}
                  onOpenChange={setComposerMembersMenuOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      data-testid="composer-space-stats"
                      aria-label={i18n.t(
                        'panels:ui.collabPage.spaceBotsVisibleroster',
                        { visibleRoster: visibleRoster.length }
                      )}
                      onMouseEnter={openComposerMembersMenu}
                      onMouseLeave={scheduleCloseComposerMembersMenu}
                      className="workspace-session-group-count cursor-pointer border-0"
                    >
                      {visibleRoster.length}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={8}
                    onMouseEnter={openComposerMembersMenu}
                    onMouseLeave={scheduleCloseComposerMembersMenu}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    className="w-60 rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
                  >
                    <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                      <span>{i18n.t('panels:ui.collabPage.spaceBots')}</span>
                      <span>{visibleRoster.length}</span>
                    </div>
                    {visibleRoster.length === 0 ? (
                      <p className="px-1 py-1.5 text-xs text-muted-foreground">
                        {COPY.noMemberSessions}
                      </p>
                    ) : (
                      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                        {visibleRoster.map((member) => {
                          const nick = displayName(member);
                          const convId = member.conversation_id ?? '';
                          const conv = convId
                            ? conversationById.get(convId)
                            : undefined;
                          const agentId =
                            conv?.agent_id ||
                            draftMemberMetaByConvId[convId]?.agentId;
                          return (
                            <button
                              key={member.member_id ?? convId ?? nick}
                              type="button"
                              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                              onClick={() => {
                                setComposerMembersMenuOpen(false);
                                selectMemberForPreview(
                                  selected.space_id,
                                  member
                                );
                              }}
                            >
                              <MemberBotAvatar
                                config={getMemberAvatar(convId, nick)}
                                className="h-3.5 w-3.5 shrink-0"
                              />
                              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {nick}
                              </span>
                              {agentId ? (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {getAgentName(agentId) || agentId}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </div>

            {replyingTo ? (
              <CollaborationReplyCapsule
                text={replyingTo.text}
                onDismiss={() => setReplyingTo(null)}
              />
            ) : null}

            <SessionComposerInput
              value={draft}
              disabled={sending}
              placeholder={
                replyingTo ? i18n.t('panels:collabCopy.replyPlaceholder') : ''
              }
              replaceValueRef={replaceDraftRef}
              context={{
                sessionId: 'collaboration-space-composer',
                workspaceId: workspace || undefined,
                workspacePath,
                repoId: repoIds[0],
                repoIds,
                spaceMembers: spaceMemberRefs,
              }}
              onChange={setDraft}
              onSubmit={(value) => {
                if (composerDisabled) return false;
                if (!value.trim() && attachedImages.length === 0) return false;
                void send(value);
                return true;
              }}
              onAttachImages={(files) => {
                void handleAttachFiles(files);
              }}
            />
            <div className="flex items-center gap-1 pt-1">
              <input
                ref={composerFileInputRef}
                type="file"
                multiple
                disabled={sending}
                className="hidden"
                onChange={handleComposerFileSelect}
              />
              <Button
                type="button"
                onClick={() => composerFileInputRef.current?.click()}
                disabled={sending}
                size="sm"
                variant="ghost"
                className="collaboration-icon-btn h-7 w-7 p-0"
                title={i18n.t('panels:ui.collabPage.chooseFile')}
                aria-label={i18n.t('panels:ui.collabPage.chooseFile')}
              >
                <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <ActionBarUtilityButtons
                compactContextEnabled={false}
                canCompactContext={false}
                isCompactingContext={false}
                promptEnhancementEnabled={promptEnhancementEnabled}
                isEnhancingPrompt={isEnhancingPrompt}
                canEnhancePrompt={Boolean(draft.trim()) && !sending}
                onCompactContext={() => {}}
                onEnhancePrompt={() => {
                  void handleEnhancePrompt();
                }}
              />
              <Button
                type="button"
                onClick={handleTriggerAtMember}
                disabled={sending}
                size="sm"
                variant="ghost"
                className="collaboration-icon-btn h-7 w-7 p-0"
                title={i18n.t('panels:ui.collabPage.bot')}
                aria-label={i18n.t('panels:ui.collabPage.bot')}
              >
                <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <div className="flex-1" />
              <ComposerPrimaryActionButton
                action="send"
                label={t('collaborationSpace.send', '发送')}
                pending={sending}
                disabled={
                  (!draft.trim() && attachedImages.length === 0) ||
                  composerDisabled
                }
                onClick={() => {
                  void send(draft);
                }}
              />
            </div>
          </SessionComposerFrame>
        </div>
      ) : null}
    </>
  );
}
