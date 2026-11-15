import { Badge } from '@astryxdesign/core/Badge';
import { AtSign, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  type ComposerDraftTargetHandle,
  type ComposerDraftToken,
  getActiveComposerDraftTargetId,
  registerComposerDraftTarget,
} from '@/lib/composerDraftTargets';
import { CollaborationReplyCapsule } from '../CollaborationReplyCapsule';

import { memo, useCallback, useEffect, useRef } from 'react';
import { BotSpaceSessionSettings } from './BotSpaceSessionSettings';
import { useCollaborationSpacePick } from './SpaceContext';

const COMPOSER_DOCK_PICK_KEYS = [
  'activeDirectThreadId',
  'attachedImages',
  'composerContainerRef',
  'composerFileInputRef',
  'draft',
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
  'promptEnhancementEnabled',
  'replaceDraftRef',
  'replyingTo',
  'repoIds',
  'selected',
  'send',
  'sending',
  'setDraft',
  'setReplyingTo',
  'spaceMemberRefs',
  'spaceQueuedMessages',
  't',
  'userDelayedSpaceMessages',
  'workspace',
  'workspacePath',
] as const;

export const ComposerDock = memo(function ComposerDock() {
  const {
    activeDirectThreadId,
    attachedImages,
    composerContainerRef,
    composerFileInputRef,
    draft,
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
    promptEnhancementEnabled,
    replaceDraftRef,
    replyingTo,
    repoIds,
    selected,
    send,
    sending,
    setDraft,
    setReplyingTo,
    spaceMemberRefs,
    spaceQueuedMessages,
    t,
    userDelayedSpaceMessages,
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

  return (
    <>
      {selected ? (
        <div
          ref={composerContainerRef}
          data-testid="collaboration-composer"
          data-space-name={selected.name}
          className="collaboration-composer-wrap"
        >
          <div className="collaboration-composer-queue">
            <div className="collaboration-composer-queue-inner">
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
                        void handleDelaySpaceQueuedMessage(
                          message,
                          delaySeconds
                        );
                      }
                }
              />
            </div>
          </div>
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
            <div className="flex flex-wrap items-center gap-1 pt-1">
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
              {isPrivateChatActive ? (
                <BotSpaceSessionSettings disabled={composerDisabled} />
              ) : null}
              <Slot
                name="composer.toolbar"
                slotProps={{
                  isEditable: !composerDisabled,
                  isAttemptRunning: sending,
                }}
              />
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
});
