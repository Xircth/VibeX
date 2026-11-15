import { memo, useCallback, useMemo } from 'react';
import { Slot } from '@/components/plugins/Slot';
import type {
  AgentSessionConfigOption,
  ExecutorConfig,
  ExecutorProfileId,
  SendMessageShortcut,
} from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { canonicalSessionAgentId } from '@/lib/sessionQueryCache';
import { ActionBarImageButton } from './ActionBarImageButton';
import { ActionBarIdleControls } from './ActionBarIdleControls';
import { ActionBarUtilityButtons } from './ActionBarUtilityButtons';
import { ActionBarRunningControls } from './ActionBarRunningControls';
import { ComposerProviderInstanceSlot } from './ComposerEngineHandoffControl';
import { ComposerStashMenu } from './ComposerStashMenu';
import {
  SessionSettingsSummary,
  type SessionContinuationConfig,
  type SessionPersona,
} from './SessionSettingsSummary';

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
  sessionControlsLoading?: boolean;
  continuation?: SessionContinuationConfig | null;
  persona?: SessionPersona | null;
  isAwaitingNewSessionConfirmation?: boolean;
  isEditable: boolean;
  isAttemptRunning: boolean;
  compactContextEnabled: boolean;
  canCompactContext: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  promptEnhancementEnabled: boolean;
  isEnhancingPrompt: boolean;
  canEnhancePrompt: boolean;
  conflictResolutionInstructions: string | null;
  comments?: unknown[];
  hasComments?: boolean;
  sendShortcut?: SendMessageShortcut | null;
  onCompactContext: () => void;
  onStopExecution: () => void;
  onSendFollowUp: () => void;
  onEnhancePrompt: () => void;
  onClearComments: () => void;
  onAttachImages: (files: File[]) => void;
  stashScopeId?: string | null;
  draftValue?: string;
  hasDraft?: boolean;
  getDraftValue?: () => string;
  attachmentCount?: number;
  onStashDraft?: () => void;
  onRestoreDraft?: (text: string) => void;
}

export const ActionBar = memo(function ActionBar({
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
  sessionControlsLoading = false,
  continuation = null,
  persona = null,
  isAwaitingNewSessionConfirmation = false,
  isEditable,
  isAttemptRunning,
  compactContextEnabled,
  canCompactContext,
  isCompactingContext,
  isStopping,
  isSendingFollowUp,
  canSendFollowUp,
  promptEnhancementEnabled,
  isEnhancingPrompt,
  canEnhancePrompt,
  conflictResolutionInstructions,
  comments,
  hasComments,
  sendShortcut,
  onCompactContext,
  onStopExecution,
  onSendFollowUp,
  onEnhancePrompt,
  onClearComments,
  onAttachImages,
  stashScopeId,
  draftValue,
  hasDraft,
  getDraftValue,
  attachmentCount = 0,
  onStashDraft,
  onRestoreDraft,
}: ActionBarProps) {
  const selectableAgents = useSelectableAgents();

  const currentAgentId = effectiveExecutorProfile?.executor ?? null;
  const currentAgentIcons = useMemo(() => {
    if (!currentAgentId) return null;
    const canonicalCurrent = canonicalSessionAgentId(currentAgentId);
    return (
      selectableAgents.find(
        (a) =>
          a.agentId === currentAgentId ||
          canonicalSessionAgentId(a.agentId) === canonicalCurrent
      ) ?? null
    );
  }, [selectableAgents, currentAgentId]);

  const handleSelectExecutorProfile = useCallback(
    (profile: ExecutorProfileId) => {
      onChangeExecutorProfile(profile);
    },
    [onChangeExecutorProfile]
  );

  const agentRail = useMemo(() => {
    if (!showProfileControls) return null;
    return {
      profiles,
      effectiveExecutorProfile,
      onChangeExecutorProfile: handleSelectExecutorProfile,
      selectableAgents,
    };
  }, [
    effectiveExecutorProfile,
    handleSelectExecutorProfile,
    profiles,
    selectableAgents,
    showProfileControls,
  ]);

  const slotProps = useMemo(
    () => ({ isEditable, isAttemptRunning }),
    [isAttemptRunning, isEditable]
  );

  const resolvedHasComments =
    hasComments ?? (comments ? comments.length > 0 : false);

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {onStashDraft && onRestoreDraft ? (
        <ComposerStashMenu
          scopeId={stashScopeId}
          draftValue={draftValue}
          hasDraft={hasDraft}
          getDraftValue={getDraftValue}
          attachmentCount={attachmentCount}
          isEditable={isEditable}
          onStashDraft={onStashDraft}
          onRestoreDraft={onRestoreDraft}
        />
      ) : null}

      <ActionBarImageButton
        isEditable={isEditable}
        onAttachImages={onAttachImages}
      />

      <ActionBarUtilityButtons
        compactContextEnabled={compactContextEnabled}
        canCompactContext={canCompactContext}
        isCompactingContext={isCompactingContext}
        promptEnhancementEnabled={promptEnhancementEnabled}
        isEnhancingPrompt={isEnhancingPrompt}
        canEnhancePrompt={canEnhancePrompt}
        onCompactContext={onCompactContext}
        onEnhancePrompt={onEnhancePrompt}
      />

      <div className="flex-1" />

      {showProfileControls ? (
        <ComposerProviderInstanceSlot
          agentId={currentAgentId}
          disabled={!isEditable}
        />
      ) : null}

      <SessionSettingsSummary
        sessionModes={sessionModes}
        selectedMode={selectedMode}
        onSelectMode={onSelectMode}
        options={sessionConfigOptions}
        pending={selectedConfigValues}
        onSelectConfigOption={onSelectConfigOption}
        persona={persona}
        disabled={!isEditable}
        dropdownAlign="end"
        agentIcon={
          showProfileControls || persona || sessionConfigOptions.length > 0 || Boolean(sessionModes?.modes?.length)
            ? currentAgentId
            : null
        }
        agentIconLight={currentAgentIcons?.iconLight ?? null}
        agentIconDark={currentAgentIcons?.iconDark ?? null}
        agentIconSvg={currentAgentIcons?.iconSvg ?? null}
        agentRail={agentRail}
        continuation={continuation}
        controlsLoading={sessionControlsLoading}
      />

      <Slot name="composer.toolbar" slotProps={slotProps} />

      {isAttemptRunning ? (
        <ActionBarRunningControls
          isStopping={isStopping}
          onStopExecution={onStopExecution}
        />
      ) : (
        <ActionBarIdleControls
          isEditable={isEditable}
          isAwaitingNewSessionConfirmation={isAwaitingNewSessionConfirmation}
          isSendingFollowUp={isSendingFollowUp}
          canSendFollowUp={canSendFollowUp}
          hasComments={resolvedHasComments}
          hasConflictResolutionInstructions={Boolean(
            conflictResolutionInstructions
          )}
          sendShortcut={sendShortcut}
          onSendFollowUp={onSendFollowUp}
          onClearComments={onClearComments}
        />
      )}
    </div>
  );
});
