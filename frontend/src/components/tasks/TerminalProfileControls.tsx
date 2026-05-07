import { Brain, Shield, Workflow } from 'lucide-react';
import type {
  BaseCodingAgent,
  ExecutorConfigs,
  ExecutorProfileId,
} from 'shared/types';
import { BaseCodingAgent as BaseCodingAgentEnum } from 'shared/types';
import { AgentSelector } from '@/components/tasks/AgentSelector';
import { CodexModelSelector } from '@/components/tasks/CodexModelSelector';
import { ConfigSelector } from '@/components/tasks/ConfigSelector';
import { OptionSelector } from '@/components/tasks/OptionSelector';
import { useClaudeSettings } from '@/hooks/useClaudeSettings';
import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type ClaudePermissionMode,
  type CodexReasoningEffort,
  type OpenCodePermissionMode,
  formatClaudePermissionLabel,
  formatOpenCodeModeLabel,
  formatOpenCodePermissionLabel,
  formatSandboxModeLabel,
  getClaudeModelOptions,
  getClaudePermissionOptions,
  getClaudeVariantConfig,
  getClaudeVariantFromSelection,
  getCodexModelOptions,
  getCodexSandboxOptions,
  getCodexVariantConfig,
  getCodexVariantFromConfigSelection,
  getDefaultProfileForExecutor,
  getOpenCodeModelOptions,
  getOpenCodeModeOptions,
  getOpenCodePermissionOptions,
  getOpenCodeVariantConfig,
  getOpenCodeVariantFromSelection,
  isClaudeCodeExecutor,
} from '@/utils/executor';

interface TerminalProfileControlsProps {
  profiles: ExecutorConfigs['executors'] | null;
  selectedProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  lockExecutor?: boolean;
  showLabel?: boolean;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}

const OPEN_CODE_DEFAULT_MODE = '__DEFAULT__';

export function TerminalProfileControls({
  profiles,
  selectedProfile,
  onChange,
  disabled,
  className = '',
  lockExecutor = false,
  showLabel = false,
  iconOnly = false,
  dropdownSide = 'bottom',
}: TerminalProfileControlsProps) {
  const executor = selectedProfile?.executor ?? null;
  const isClaude = isClaudeCodeExecutor(executor);
  const isCodex = executor === BaseCodingAgentEnum.CODEX;
  const isOpencode = executor === BaseCodingAgentEnum.OPENCODE;
  const { settings: claudeSettings } = useClaudeSettings();

  const contentClassName = className || 'flex flex-col gap-2 w-full';

  if (!profiles || !selectedProfile || !executor) {
    return null;
  }

  const handleExecutorChange = (nextExecutor: BaseCodingAgent) => {
    const nextProfile = getDefaultProfileForExecutor(
      nextExecutor,
      profiles
    ) ?? {
      executor: nextExecutor,
      variant: null,
    };

    onChange(nextProfile);
  };

  const variantSelector = (
    <ConfigSelector
      profiles={profiles}
      selectedExecutorProfile={selectedProfile}
      onChange={onChange}
      disabled={disabled}
      showLabel={showLabel && lockExecutor}
      iconOnly={iconOnly}
      dropdownSide={dropdownSide}
    />
  );

  const renderClaudeControls = () => {
    const currentConfig = getClaudeVariantConfig(
      profiles,
      selectedProfile.variant ?? null
    );
    const permissionOptions = getClaudePermissionOptions(profiles);
    const modelOptions = getClaudeModelOptions(profiles, claudeSettings?.env);
    const hasRichControls =
      permissionOptions.length > 1 || modelOptions.length > 1;

    if (!hasRichControls) {
      return variantSelector;
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        {permissionOptions.length > 1 ? (
          <OptionSelector<ClaudePermissionMode>
            value={currentConfig.permissionMode}
            options={permissionOptions.map((permissionMode) => ({
              value: permissionMode,
              label: formatClaudePermissionLabel(permissionMode),
              icon: Shield,
            }))}
            onChange={(permissionMode) =>
              onChange({
                executor,
                variant: getClaudeVariantFromSelection(
                  profiles,
                  permissionMode,
                  currentConfig.model
                ),
              })
            }
            disabled={disabled}
            menuLabel="Permissions"
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}

        {modelOptions.length > 1 ? (
          <CodexModelSelector
            value={currentConfig.model}
            options={modelOptions}
            onChange={(model) =>
              onChange({
                executor,
                variant: getClaudeVariantFromSelection(
                  profiles,
                  currentConfig.permissionMode,
                  model
                ),
              })
            }
            disabled={disabled}
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}
      </div>
    );
  };

  const renderCodexControls = () => {
    const currentConfig = getCodexVariantConfig(
      profiles,
      selectedProfile.variant ?? null
    );
    const sandboxOptions = getCodexSandboxOptions(profiles);
    const modelOptions = getCodexModelOptions(profiles);
    const reasoningOptions = CODEX_REASONING_EFFORT_OPTIONS;

    const hasRichControls =
      sandboxOptions.length > 1 ||
      modelOptions.length > 1 ||
      reasoningOptions.length > 1;

    if (!hasRichControls) {
      return variantSelector;
    }

    const updateVariant = (next: {
      model?: string | null;
      sandbox?: typeof currentConfig.sandbox;
      approvalPolicy?: typeof currentConfig.approvalPolicy;
      reasoningEffort?: CodexReasoningEffort;
    }) => {
      onChange({
        executor,
        variant: getCodexVariantFromConfigSelection(profiles, {
          model: next.model === undefined ? currentConfig.model : next.model,
          sandbox:
            next.sandbox === undefined ? currentConfig.sandbox : next.sandbox,
          approvalPolicy:
            next.approvalPolicy === undefined
              ? currentConfig.approvalPolicy
              : next.approvalPolicy,
          reasoningEffort:
            next.reasoningEffort ?? currentConfig.reasoningEffort,
        }),
      });
    };

    return (
      <div className="flex flex-wrap items-center gap-2">
        {sandboxOptions.length > 1 ? (
          <OptionSelector
            value={currentConfig.sandbox}
            options={sandboxOptions.map((sandbox) => ({
              value: sandbox,
              label: formatSandboxModeLabel(sandbox),
              icon: Shield,
            }))}
            onChange={(sandbox) => updateVariant({ sandbox })}
            disabled={disabled}
            menuLabel="Sandbox"
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}

        {modelOptions.length > 1 ? (
          <CodexModelSelector
            value={currentConfig.model}
            options={modelOptions}
            onChange={(model) => updateVariant({ model })}
            disabled={disabled}
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}

        {reasoningOptions.length > 1 ? (
          <OptionSelector<CodexReasoningEffort>
            value={currentConfig.reasoningEffort}
            options={reasoningOptions.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description,
              icon: Brain,
            }))}
            onChange={(reasoningEffort) => updateVariant({ reasoningEffort })}
            disabled={disabled}
            menuLabel="Reasoning"
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}
      </div>
    );
  };

  const renderOpenCodeControls = () => {
    const currentConfig = getOpenCodeVariantConfig(
      profiles,
      selectedProfile.variant ?? null
    );
    const modelOptions = getOpenCodeModelOptions(profiles);
    const permissionOptions = getOpenCodePermissionOptions(profiles);
    const modeOptions = getOpenCodeModeOptions(profiles);
    const encodedModeValue = currentConfig.agentMode ?? OPEN_CODE_DEFAULT_MODE;

    const hasRichControls =
      modelOptions.length > 1 ||
      permissionOptions.length > 1 ||
      modeOptions.length > 1;

    if (!hasRichControls) {
      return variantSelector;
    }

    const updateVariant = (next: {
      model?: string | null;
      permissionMode?: OpenCodePermissionMode;
      agentMode?: string | null;
    }) => {
      onChange({
        executor,
        variant: getOpenCodeVariantFromSelection(profiles, {
          model: next.model === undefined ? currentConfig.model : next.model,
          permissionMode: next.permissionMode ?? currentConfig.permissionMode,
          agentMode:
            next.agentMode === undefined
              ? currentConfig.agentMode
              : next.agentMode,
        }),
      });
    };

    return (
      <div className="flex flex-wrap items-center gap-2">
        {modeOptions.length > 1 ? (
          <OptionSelector
            value={encodedModeValue}
            options={modeOptions.map((agentMode) => ({
              value: agentMode ?? OPEN_CODE_DEFAULT_MODE,
              label: formatOpenCodeModeLabel(agentMode),
              icon: Workflow,
            }))}
            onChange={(value) =>
              updateVariant({
                agentMode: value === OPEN_CODE_DEFAULT_MODE ? null : value,
              })
            }
            disabled={disabled}
            menuLabel="Mode"
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}

        {permissionOptions.length > 1 ? (
          <OptionSelector<OpenCodePermissionMode>
            value={currentConfig.permissionMode}
            options={permissionOptions.map((permissionMode) => ({
              value: permissionMode,
              label: formatOpenCodePermissionLabel(permissionMode),
              icon: Shield,
            }))}
            onChange={(permissionMode) => updateVariant({ permissionMode })}
            disabled={disabled}
            menuLabel="Permissions"
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}

        {modelOptions.length > 1 ? (
          <CodexModelSelector
            value={currentConfig.model}
            options={modelOptions}
            onChange={(model) => updateVariant({ model })}
            disabled={disabled}
            iconOnly={iconOnly}
            dropdownSide={dropdownSide}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className={contentClassName}>
      {!lockExecutor ? (
        <AgentSelector
          profiles={profiles}
          selectedExecutorProfile={selectedProfile}
          onChange={(profile) => handleExecutorChange(profile.executor)}
          disabled={disabled}
          iconOnly={iconOnly}
          dropdownSide={dropdownSide}
        />
      ) : null}

      {isClaude
        ? renderClaudeControls()
        : isCodex
          ? renderCodexControls()
          : isOpencode
            ? renderOpenCodeControls()
            : variantSelector}
    </div>
  );
}
