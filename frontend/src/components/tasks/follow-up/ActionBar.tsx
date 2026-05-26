import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import type { ExecutorConfig, ExecutorProfileId } from 'shared/types';
import { hasFollowUpContent } from './sessionComposerSubmit';
import { ActionBarImageButton } from './ActionBarImageButton';
import { ActionBarIdleControls } from './ActionBarIdleControls';
import { ActionBarUtilityButtons } from './ActionBarUtilityButtons';
import { ActionBarRunningControls } from './ActionBarRunningControls';

interface ActionBarProps {
  profiles: Record<string, ExecutorConfig> | null;
  effectiveExecutorProfile: ExecutorProfileId | null;
  onChangeExecutorProfile: (profile: ExecutorProfileId | null) => void;
  showProfileControls?: boolean;
  isAwaitingNewSessionConfirmation?: boolean;
  isEditable: boolean;
  isAttemptRunning: boolean;
  isQueued: boolean;
  isQueueLoading: boolean;
  canCompactContext: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  promptEnhancementEnabled: boolean;
  isEnhancingPrompt: boolean;
  canEnhancePrompt: boolean;
  sessionId?: string;
  localMessage: string;
  attachmentCount?: number;
  conflictResolutionInstructions: string | null;
  reviewMarkdown: string | null;
  comments: unknown[];
  onCompactContext: () => void;
  onQueueMessage: () => void;
  onCancelQueue: () => void;
  onStopExecution: () => void;
  onSendFollowUp: () => void;
  onEnhancePrompt: () => void;
  onClearComments: () => void;
  onAttachImages: (files: File[]) => void;
}

export function ActionBar({
  profiles,
  effectiveExecutorProfile,
  onChangeExecutorProfile,
  showProfileControls = true,
  isAwaitingNewSessionConfirmation = false,
  isEditable,
  isAttemptRunning,
  isQueued,
  isQueueLoading,
  canCompactContext,
  isCompactingContext,
  isStopping,
  isSendingFollowUp,
  canSendFollowUp,
  promptEnhancementEnabled,
  isEnhancingPrompt,
  canEnhancePrompt,
  sessionId,
  localMessage,
  attachmentCount = 0,
  conflictResolutionInstructions,
  reviewMarkdown,
  comments,
  onCompactContext,
  onQueueMessage,
  onCancelQueue,
  onStopExecution,
  onSendFollowUp,
  onEnhancePrompt,
  onClearComments,
  onAttachImages,
}: ActionBarProps) {
  const hasQueueableContent = hasFollowUpContent({
    message: localMessage,
    conflictMarkdown: conflictResolutionInstructions,
    reviewMarkdown,
    imageCount: attachmentCount,
  });

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {showProfileControls ? (
        <TerminalProfileControls
          profiles={profiles}
          selectedProfile={effectiveExecutorProfile}
          onChange={onChangeExecutorProfile}
          disabled={!isEditable}
          lockExecutor={true}
          iconOnly={true}
          dropdownSide="top"
          className="flex flex-wrap items-center gap-1"
        />
      ) : null}

      <ActionBarImageButton
        isEditable={isEditable}
        onAttachImages={onAttachImages}
      />

      <ActionBarUtilityButtons
        canCompactContext={canCompactContext}
        isCompactingContext={isCompactingContext}
        promptEnhancementEnabled={promptEnhancementEnabled}
        isEnhancingPrompt={isEnhancingPrompt}
        canEnhancePrompt={canEnhancePrompt}
        onCompactContext={onCompactContext}
        onEnhancePrompt={onEnhancePrompt}
      />

      <div className="flex-1" />

      {isAttemptRunning ? (
        <ActionBarRunningControls
          isQueued={isQueued}
          isQueueLoading={isQueueLoading}
          isCompactingContext={isCompactingContext}
          isStopping={isStopping}
          hasQueueableContent={Boolean(hasQueueableContent)}
          sessionId={sessionId}
          onQueueMessage={onQueueMessage}
          onCancelQueue={onCancelQueue}
          onStopExecution={onStopExecution}
        />
      ) : (
        <ActionBarIdleControls
          isEditable={isEditable}
          isAwaitingNewSessionConfirmation={isAwaitingNewSessionConfirmation}
          isSendingFollowUp={isSendingFollowUp}
          canSendFollowUp={canSendFollowUp}
          hasComments={comments.length > 0}
          hasConflictResolutionInstructions={Boolean(
            conflictResolutionInstructions
          )}
          onSendFollowUp={onSendFollowUp}
          onClearComments={onClearComments}
        />
      )}
    </div>
  );
}
