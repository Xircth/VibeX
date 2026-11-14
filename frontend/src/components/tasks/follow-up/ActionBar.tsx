import { useMemo } from 'react';
import { Slot } from '@/components/plugins/Slot';
import type {
  AgentSessionConfigOption,
  ExecutorConfig,
  ExecutorProfileId,
} from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { ActionBarImageButton } from './ActionBarImageButton';
import { ActionBarIdleControls } from './ActionBarIdleControls';
import { ActionBarUtilityButtons } from './ActionBarUtilityButtons';
import { ActionBarRunningControls } from './ActionBarRunningControls';
import { AgentRail } from './AgentRail';
import {
  SessionSettingsSummary,
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
  comments: unknown[];
  onCompactContext: () => void;
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
  onCompactContext,
  onStopExecution,
  onSendFollowUp,
  onEnhancePrompt,
  onClearComments,
  onAttachImages,
}: ActionBarProps) {
  const selectableAgents = useSelectableAgents();

  const currentAgentId = effectiveExecutorProfile?.executor ?? null;
  const currentAgentIcons = useMemo(() => {
    if (!currentAgentId) return null;
    return selectableAgents.find((a) => a.agentId === currentAgentId) ?? null;
  }, [selectableAgents, currentAgentId]);

  const handleAgentSelect = (profile: ExecutorProfileId) => {
    onChangeExecutorProfile(profile);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {showProfileControls ? (
        <AgentRail
          profiles={profiles}
          effectiveExecutorProfile={effectiveExecutorProfile}
          onChangeExecutorProfile={handleAgentSelect}
          disabled={!isEditable}
          selectableAgents={selectableAgents}
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
        agentIcon={currentAgentId}
        agentIconLight={currentAgentIcons?.iconLight ?? null}
        agentIconDark={currentAgentIcons?.iconDark ?? null}
        agentIconSvg={currentAgentIcons?.iconSvg ?? null}
      />

      <div className="flex-1" />

      <ActionBarImageButton
        isEditable={isEditable}
        onAttachImages={onAttachImages}
      />

      <Slot
        name="composer.toolbar"
        slotProps={{ isEditable, isAttemptRunning }}
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
