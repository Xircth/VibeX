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
import { SessionModeSelector } from './SessionModeSelector';
import { SessionConfigOptionSelectors } from './SessionConfigOptionSelectors';

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

  // Once the agent advertises live ACP config options, they are the source of
  // truth for model / permission choices — suppress the overlapping static
  // profile pickers so the composer never shows two competing selectors.
  const hasAcpConfigOptions = sessionConfigOptions.some(
    (option) => (option.choices?.length ?? 0) > 1
  );
  // Claude's adapter advertises the permission mode both as `modes` and as a
  // `mode`-category config option; the dedicated mode picker wins.
  const showModeSelector = Boolean(
    sessionModes && onSelectMode && sessionModes.modes.length > 0
  );
  const dedupedConfigOptions = showModeSelector
    ? sessionConfigOptions.filter(
        (option) => (option.category ?? option.key) !== 'mode'
      )
    : sessionConfigOptions;

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
          suppressAcpManagedControls={hasAcpConfigOptions}
        />
      ) : null}

      {sessionModes && onSelectMode ? (
        <SessionModeSelector
          modes={sessionModes.modes}
          current={sessionModes.current}
          selected={selectedMode}
          onSelect={onSelectMode}
          disabled={!isEditable}
        />
      ) : null}

      {onSelectConfigOption ? (
        <SessionConfigOptionSelectors
          options={dedupedConfigOptions}
          pending={selectedConfigValues}
          onSelect={onSelectConfigOption}
          disabled={!isEditable}
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
