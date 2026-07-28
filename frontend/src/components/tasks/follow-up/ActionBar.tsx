import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import type {
  AgentSessionConfigOption,
  ExecutorConfig,
  ExecutorProfileId,
} from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import { hasFollowUpContent } from './sessionComposerSubmit';
import { ActionBarImageButton } from './ActionBarImageButton';
import { ActionBarIdleControls } from './ActionBarIdleControls';
import { ActionBarUtilityButtons } from './ActionBarUtilityButtons';
import { ActionBarRunningControls } from './ActionBarRunningControls';
import { SessionSettingsSummary } from './SessionSettingsSummary';

interface ActionBarProps {
  profiles: Record<string, ExecutorConfig> | null;
  effectiveExecutorProfile: ExecutorProfileId | null;
  onChangeExecutorProfile: (profile: ExecutorProfileId | null) => void;
  showProfileControls?: boolean;
  /** Agent-advertised session modes for the composer's mode picker. */
  sessionModes?: ConversationSessionModesState;
  /** The user's pending mode selection for the next turn. */
  selectedMode?: string | null;
  onSelectMode?: (modeId: string) => void;
  /** Agent-advertised ACP config options (model / permission / …). */
  sessionConfigOptions?: AgentSessionConfigOption[];
  /** Pending per-option config selections for the next turn (key → value). */
  selectedConfigValues?: Record<string, string>;
  onSelectConfigOption?: (key: string, value: string) => void;
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
  sessionModes,
  selectedMode = null,
  onSelectMode,
  sessionConfigOptions = [],
  selectedConfigValues = {},
  onSelectConfigOption,
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
          // Capability choices come exclusively from the live ACP session or
          // persisted catalog. Static executor profiles remain defaults, not a
          // competing model/permission/Fast selector source.
          suppressAcpManagedControls={true}
        />
      ) : null}

      <SessionSettingsSummary
        sessionModes={sessionModes}
        selectedMode={selectedMode}
        onSelectMode={onSelectMode}
        options={sessionConfigOptions}
        pending={selectedConfigValues}
        onSelectConfigOption={onSelectConfigOption}
        disabled={!isEditable}
      />

      <div className="flex-1" />

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
