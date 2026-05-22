import { useEffect, useState } from 'react';
import { Brain, ChevronDown, Cpu, Shield, Workflow } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useClaudeSettings } from '@/hooks/useClaudeSettings';
import { cn } from '@/lib/utils';
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
  mergeModelOptions,
  type CodexModelOption,
} from '@/utils/executor';
import { providerRuntimeApi } from '@/lib/providerRuntime';

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

type OpenCodeProviderOption = {
  id: string;
  label: string;
  models: CodexModelOption[];
};

function formatOpenCodeLabel(value: string | null): string {
  if (!value) return 'Model';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) =>
      /^[a-z]+$/i.test(part) && part.length <= 3
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}

function splitOpenCodeModel(value: string | null): {
  providerId: string;
  modelId: string | null;
} {
  if (!value) return { providerId: 'unselected', modelId: null };
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return { providerId: 'custom', modelId: value };
  }
  return {
    providerId: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

function openCodeProviderLabel(
  providerId: string,
  optionLabel: string
): string {
  const [provider] = optionLabel.split(/\s+\/\s+/, 1);
  if (provider && provider !== optionLabel) return provider;
  if (providerId === 'unselected') return 'Model';
  if (providerId === 'custom') return 'Custom';
  return formatOpenCodeLabel(providerId);
}

function openCodeModelLabel(option: CodexModelOption): string {
  if (!option.value) return 'Model';
  const [, modelLabel] = option.label.split(/\s+\/\s+/, 2);
  if (modelLabel) return modelLabel;
  return formatOpenCodeLabel(splitOpenCodeModel(option.value).modelId);
}

function groupOpenCodeModels(
  options: CodexModelOption[]
): OpenCodeProviderOption[] {
  const providers = new Map<string, OpenCodeProviderOption>();
  for (const option of options) {
    const { providerId } = splitOpenCodeModel(option.value);
    const existing = providers.get(providerId);
    if (existing) {
      existing.models.push(option);
      continue;
    }
    providers.set(providerId, {
      id: providerId,
      label: openCodeProviderLabel(providerId, option.label),
      models: [option],
    });
  }
  return Array.from(providers.values());
}

function OpenCodeModelSelector({
  value,
  options,
  onChange,
  disabled,
  iconOnly = false,
  dropdownSide = 'bottom',
}: {
  value: string | null;
  options: CodexModelOption[];
  onChange: (model: string | null) => void;
  disabled?: boolean;
  iconOnly?: boolean;
  dropdownSide?: 'top' | 'bottom';
}) {
  const providers = groupOpenCodeModels(options);
  const current = options.find((option) => option.value === value) ?? null;
  const currentProvider = current
    ? providers.find(
        (provider) =>
          provider.id === splitOpenCodeModel(current.value).providerId
      )
    : null;
  const [open, setOpen] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(
    currentProvider?.id ?? providers[0]?.id ?? null
  );

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setExpandedProviderId(
            currentProvider?.id ?? providers[0]?.id ?? null
          );
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant={iconOnly ? 'ghost' : 'secondary'}
          size="sm"
          className={cn(
            iconOnly
              ? 'h-7 w-7 px-0 border-0 shadow-none justify-center'
              : 'px-2 flex items-center gap-1'
          )}
          disabled={disabled}
          title={current?.label ?? 'Model'}
        >
          <Cpu className="h-3 w-3" />
          {!iconOnly ? (
            <span className="text-xs truncate max-w-[160px]">
              {current && currentProvider
                ? `${currentProvider.label} / ${openCodeModelLabel(current)}`
                : 'Model'}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align="start"
        sideOffset={1}
        avoidCollisions={false}
        className="min-w-[240px]"
      >
        <DropdownMenuLabel>Provider</DropdownMenuLabel>
        {providers.map((provider) => {
          const expanded = expandedProviderId === provider.id;
          return (
            <div key={provider.id}>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setExpandedProviderId(expanded ? null : provider.id);
                }}
              >
                <Workflow className="mr-2 h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {provider.label}
                </span>
                <ChevronDown
                  className={cn(
                    'ml-2 h-3.5 w-3.5 text-muted-foreground transition-transform',
                    expanded ? 'rotate-180' : ''
                  )}
                />
              </DropdownMenuItem>
              {expanded
                ? provider.models.map((option) => (
                    <DropdownMenuItem
                      key={option.value ?? 'DEFAULT'}
                      onSelect={() => onChange(option.value)}
                      className={cn(
                        'pl-8',
                        value === option.value ? 'bg-accent' : ''
                      )}
                    >
                      <Cpu className="mr-2 h-3.5 w-3.5" />
                      <span className="text-xs">
                        {openCodeModelLabel(option)}
                      </span>
                    </DropdownMenuItem>
                  ))
                : null}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const [openCodeSdkModelOptions, setOpenCodeSdkModelOptions] = useState<
    CodexModelOption[]
  >([]);

  useEffect(() => {
    if (!isOpencode) {
      setOpenCodeSdkModelOptions([]);
      return;
    }

    let cancelled = false;
    providerRuntimeApi
      .listModels('opencode')
      .then((models) => {
        if (cancelled) return;
        setOpenCodeSdkModelOptions(
          models.map((model) => ({
            value: model.id,
            label: model.label || model.id,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setOpenCodeSdkModelOptions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpencode]);

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
    const currentModel = selectedProfile.model ?? currentConfig.model;
    const modelOptions = mergeModelOptions(
      getCodexModelOptions(profiles),
      [],
      currentModel
    );
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
      const selectedModel =
        next.model === undefined
          ? currentModel
          : (next.model ?? currentConfig.model);
      const selectedSandbox =
        next.sandbox === undefined ? currentConfig.sandbox : next.sandbox;
      const selectedApprovalPolicy =
        next.approvalPolicy === undefined
          ? currentConfig.approvalPolicy
          : next.approvalPolicy;
      const selectedReasoningEffort =
        next.reasoningEffort ?? currentConfig.reasoningEffort;
      const variant = getCodexVariantFromConfigSelection(profiles, {
        model: selectedModel,
        sandbox: selectedSandbox,
        approvalPolicy: selectedApprovalPolicy,
        reasoningEffort: selectedReasoningEffort,
      });
      const variantConfig = getCodexVariantConfig(profiles, variant);
      const modelOverride =
        selectedModel === variantConfig.model ? null : selectedModel;

      onChange({
        executor,
        variant,
        model: modelOverride,
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
            value={currentModel}
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
    const currentModel = selectedProfile.model ?? currentConfig.model;
    const modelOptions = mergeModelOptions(
      getOpenCodeModelOptions(profiles),
      openCodeSdkModelOptions,
      currentModel
    );
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
      const selectedModel =
        next.model === undefined ? currentModel : next.model;
      const selectedPermissionMode =
        next.permissionMode ?? currentConfig.permissionMode;
      const selectedAgentMode =
        next.agentMode === undefined ? currentConfig.agentMode : next.agentMode;
      const variant = getOpenCodeVariantFromSelection(profiles, {
        model: selectedModel,
        permissionMode: selectedPermissionMode,
        agentMode: selectedAgentMode,
      });
      const variantConfig = getOpenCodeVariantConfig(profiles, variant);
      const modelOverride =
        selectedModel === variantConfig.model ? null : selectedModel;

      onChange({
        executor,
        variant,
        model: modelOverride,
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
          <OpenCodeModelSelector
            value={currentModel}
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
