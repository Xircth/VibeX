import { Badge } from '@astryxdesign/core/Badge';
import { AtSign, Paperclip, Sparkles } from 'lucide-react';
import { getAgentName } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Slot } from '@/components/plugins/Slot';
import { ActionBarUtilityButtons } from '@/components/tasks/follow-up/ActionBarUtilityButtons';
import { ComposerPrimaryActionButton } from '@/components/tasks/follow-up/ComposerPrimaryActionButton';
import { MessageQueueIndicator } from '@/components/tasks/follow-up/MessageQueueIndicator';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from '@/components/tasks/follow-up/SessionComposerInput';
import { insertPreviewElementToken } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import i18n from '@/i18n';
import { backendListen } from '@/lib/backendTransport';
import type { PulseRuleSpec } from '@/lib/api/pulse';
import {
  type ComposerDraftTargetHandle,
  type ComposerDraftToken,
  getActiveComposerDraftTargetId,
  registerComposerDraftTarget,
} from '@/lib/composerDraftTargets';
import { COPY, displayName } from '../spaceModel';
import { MemberBotAvatar, deriveMemberBotAvatar } from '../MemberBotAvatar';
import { GroupAvatar } from '../GroupAvatar';
import { CollaborationReplyCapsule } from '../CollaborationReplyCapsule';
import {
  isAutomateSlashCommand,
  parseAutomateSlashIntent,
} from '../collaborationComposerSend';
import {
  COLLABORATION_PULSE_PROPOSAL_EVENT,
  buildBotPulseProposalSpec,
  buildGroupPulseProposalSpec,
  type CollaborationPulseProposalDetail,
} from '../collaborationPulseEvents';
import { PulseRuleProposalCard } from '../PulseRuleProposalCard';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCollaborationSpacePick } from './SpaceContext';

const COMPOSER_DOCK_PICK_KEYS = [
  'activeDirectThreadId',
  'attachedImages',
  'composerContainerRef',
  'composerFileInputRef',
  'composerMembersMenuOpen',
  'conversationById',
  'draft',
  'draftMemberMetaByConvId',
  'getMemberAvatar',
  'handleAttachFiles',
  'handleComposerFileSelect',
  'handleDelaySpaceQueuedMessage',
  'handleDeleteSpaceQueuedMessage',
  'handleEditSpaceQueuedMessage',
  'handleEnhancePrompt',
  'handleRemoveAttachedImage',
  'handleTriggerAtMember',
  'isBotSessionLoading',
  'isEnhancingPrompt',
  'isPrivateChatActive',
  'memberAvatars',
  'openComposerMembersMenu',
  'promptEnhancementEnabled',
  'replaceDraftRef',
  'replyingTo',
  'repoIds',
  'scheduleCloseComposerMembersMenu',
  'selectMemberForPreview',
  'selected',
  'selectedTagPreset',
  'send',
  'sending',
  'setComposerMembersMenuOpen',
  'setDraft',
  'setReplyingTo',
  'spaceMemberRefs',
  'spaceQueuedMessages',
  't',
  'userDelayedSpaceMessages',
  'visibleRoster',
  'workspace',
  'workspacePath',
] as const;

export const ComposerDock = memo(function ComposerDock() {
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
  } = useCollaborationSpacePick(COMPOSER_DOCK_PICK_KEYS);

  const showBotSessionLoadingNotice = Boolean(
    isPrivateChatActive && isBotSessionLoading
  );
  const composerDisabled = sending || showBotSessionLoadingNotice;
  const isEditable = Boolean(selected) && !composerDisabled;

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const isEditableRef = useRef(isEditable);
  isEditableRef.current = isEditable;
  const draftTargetHandleRef = useRef<ComposerDraftTargetHandle | null>(null);

  const applyDraftInsertion = useCallback(
    (nextValue: string) => {
      draftRef.current = nextValue;
      if (replaceDraftRef.current) {
        replaceDraftRef.current(nextValue);
      } else {
        setDraftRef.current(nextValue);
      }
    },
    [replaceDraftRef]
  );

  const insertDraftToken = useCallback(
    (token: ComposerDraftToken) => {
      const currentMessage = draftRef.current;
      const plainText = token.text?.trim() ?? '';
      if (plainText && !token.label?.trim()) {
        const needsSpace =
          currentMessage.length > 0 &&
          !/[\s\u3000-\u303f\uff00-\uffef]$/.test(currentMessage) &&
          !/^[\s\u3000-\u303f\uff00-\uffef]/.test(plainText);
        const nextValue = `${currentMessage}${needsSpace ? ' ' : ''}${plainText}`;
        applyDraftInsertion(nextValue);
        return;
      }
      const next = insertPreviewElementToken({
        value: currentMessage,
        selectionStart: currentMessage.length,
        selectionEnd: currentMessage.length,
        componentName: token.label,
        filePath: '',
        fullMarkdown: token.markdown,
      });
      applyDraftInsertion(next.value);
    },
    [applyDraftInsertion]
  );

  useEffect(() => {
    if (!isEditable) return undefined;
    const handle = registerComposerDraftTarget({
      isEditable: () => isEditableRef.current,
      insert: insertDraftToken,
    });
    draftTargetHandleRef.current = handle;
    return () => {
      handle.dispose();
      if (draftTargetHandleRef.current === handle) {
        draftTargetHandleRef.current = null;
      }
    };
  }, [isEditable, insertDraftToken]);

  useEffect(() => {
    if (!isEditable) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void backendListen(
      'plugin-conversation-draft-insert',
      (payload: {
        text?: string;
        token?: { label?: string; markdown?: string; text?: string };
      }) => {
        const label = payload.token?.label?.trim() ?? '';
        const markdown = payload.token?.markdown?.trim() ?? '';
        const text = payload.token?.text?.trim() ?? payload.text?.trim() ?? '';
        if ((!label || !markdown) && !text) return;
        const handle = draftTargetHandleRef.current;
        if (!handle || getActiveComposerDraftTargetId() !== handle.id) return;
        insertDraftToken({
          label,
          markdown,
          ...(text ? { text } : {}),
        });
      }
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isEditable, insertDraftToken]);

  const markDraftTargetFocused = useCallback(() => {
    draftTargetHandleRef.current?.markFocused();
  }, []);

  const rosterOptions = useMemo(
    () =>
      visibleRoster.map((member) => {
        const nickname = displayName(member);
        const memberId =
          member.member_id?.trim() ||
          member.conversation_id?.trim() ||
          nickname;
        return { memberId, nickname };
      }),
    [visibleRoster]
  );

  const [activePulseProposal, setActivePulseProposal] = useState<{
    key: number;
    spec: PulseRuleSpec;
    contextLabel: string;
  } | null>(null);

  useEffect(() => {
    const handleProposalRequest = (event: Event) => {
      const detail = (event as CustomEvent<CollaborationPulseProposalDetail>)
        .detail;
      if (!detail) return;

      if (detail.kind === 'spec') {
        setActivePulseProposal({
          key: Date.now(),
          spec: detail.spec,
          contextLabel: detail.contextLabel ?? selected?.name ?? 'Pulse',
        });
        return;
      }

      if (detail.kind === 'bot') {
        setActivePulseProposal({
          key: Date.now(),
          spec: buildBotPulseProposalSpec({
            memberId: detail.memberId,
            botName: detail.botName,
            sourceKind:
              detail.mode === 'schedule' ? 'time_cron' : 'webhook_standard',
            workspaceId: detail.workspaceId ?? (workspace || null),
            projectId: detail.projectId ?? null,
          }),
          contextLabel: detail.botName,
        });
        return;
      }

      if (detail.kind === 'group-seat') {
        const resolvedSpaceId = detail.spaceId || selected?.space_id || '';
        const resolvedSpaceName = detail.spaceName || selected?.name || 'Group';
        const matchedSeat = rosterOptions.find(
          (item) =>
            (detail.memberId && item.memberId === detail.memberId) ||
            item.nickname === detail.nickname
        );
        const resolvedMemberId =
          detail.memberId || matchedSeat?.memberId || detail.nickname;
        if (!resolvedSpaceId) return;
        setActivePulseProposal({
          key: Date.now(),
          spec: buildGroupPulseProposalSpec({
            spaceId: resolvedSpaceId,
            spaceName: resolvedSpaceName,
            dispatchMode: {
              type: 'specific_seat',
              memberId: resolvedMemberId,
            },
            workspaceId: detail.workspaceId ?? (workspace || null),
            projectId: detail.projectId ?? null,
          }),
          contextLabel: `${resolvedSpaceName} → @${detail.nickname}`,
        });
      }
    };

    window.addEventListener(
      COLLABORATION_PULSE_PROPOSAL_EVENT,
      handleProposalRequest
    );
    return () => {
      window.removeEventListener(
        COLLABORATION_PULSE_PROPOSAL_EVENT,
        handleProposalRequest
      );
    };
  }, [rosterOptions, selected?.name, selected?.space_id, workspace]);

  const trySubmitAutomateSlash = useCallback(
    (rawValue: string): boolean => {
      if (!selected || !isAutomateSlashCommand(rawValue)) {
        return false;
      }
      const isBotThread = Boolean(activeDirectThreadId);
      const botMemberId =
        rosterOptions[0]?.memberId ||
        (activeDirectThreadId
          ? activeDirectThreadId.replace(/^direct:/, '')
          : selected.space_id);

      const parsed = parseAutomateSlashIntent(
        rawValue,
        rosterOptions,
        isBotThread
          ? {
              kind: 'bot',
              memberId: botMemberId,
              botName: selected.name,
              workspaceId: workspace || null,
            }
          : {
              kind: 'group',
              spaceId: selected.space_id,
              spaceName: selected.name,
              leadMemberId: selected.lead_member_id ?? null,
              workspaceId: workspace || null,
            }
      );

      if (!parsed) return false;
      applyDraftInsertion('');
      setActivePulseProposal({
        key: Date.now(),
        spec: parsed.spec,
        contextLabel: isBotThread
          ? `Bot: ${selected.name}`
          : `Group: ${selected.name}`,
      });
      return true;
    },
    [
      activeDirectThreadId,
      applyDraftInsertion,
      rosterOptions,
      selected,
      workspace,
    ]
  );

  const isAutomateDraft = isAutomateSlashCommand(draft);

  return (
    <>
      {selected ? (
        <div ref={composerContainerRef} className="collaboration-composer-wrap">
          {activePulseProposal ? (
            <div className="mb-2" data-testid="composer-pulse-proposal-drawer">
              <PulseRuleProposalCard
                key={activePulseProposal.key}
                initialSpec={activePulseProposal.spec}
                contextLabel={activePulseProposal.contextLabel}
                roster={rosterOptions}
                onSaved={() => setActivePulseProposal(null)}
                onCancel={() => setActivePulseProposal(null)}
              />
            </div>
          ) : null}
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
            onFocus={markDraftTargetFocused}
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
                {isAutomateDraft ? (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                    data-testid="composer-automate-intent-pill"
                  >
                    <Sparkles className="h-2.5 w-2.5" />
                    Pulse /automate
                  </span>
                ) : null}
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
                      className="workspace-session-group-count cursor-pointer border-0 tabular-nums"
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
                      <span className="tabular-nums">
                        {visibleRoster.length}
                      </span>
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
                if (trySubmitAutomateSlash(value)) return true;
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
              <Slot
                name="composer.toolbar"
                slotProps={{
                  isEditable: !composerDisabled,
                  isAttemptRunning: sending,
                }}
              />
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
                  if (trySubmitAutomateSlash(draft)) return;
                  void send(draft);
                }}
              />
            </div>
          </SessionComposerFrame>
        </div>
      ) : null}
    </>
  );
});
