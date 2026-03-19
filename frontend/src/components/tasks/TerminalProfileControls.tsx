import { useEffect, useMemo, useState } from 'react';
import type { BaseCodingAgent, ExecutorConfigs, ExecutorProfileId } from 'shared/types';
import { BaseCodingAgent as BaseCodingAgentEnum } from 'shared/types';
import { AgentSelector } from '@/components/tasks/AgentSelector';
import { ConfigSelector } from '@/components/tasks/ConfigSelector';
import {
  CodexModelSelector,
  type CodexModelOption,
} from '@/components/tasks/CodexModelSelector';
import { ModelSelector, type ModelKey } from '@/components/tasks/ModelSelector';
import { PermissionSelector, type PermissionMode } from '@/components/tasks/PermissionSelector';
import {
  getDefaultVariantForExecutor,
  getDefaultProfileForExecutor,
  getVariantOptions,
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
}

function getClaudeUiState(variant: string | null | undefined): {
  permissionMode: PermissionMode;
  modelKey: ModelKey;
} {
  switch (variant ?? 'DEFAULT') {
    case 'OPUS':
      return { permissionMode: 'auto', modelKey: 'opus' };
    case 'PLAN':
      return { permissionMode: 'plan', modelKey: 'default' };
    case 'APPROVALS':
      return { permissionMode: 'ask', modelKey: 'default' };
    default:
      return { permissionMode: 'auto', modelKey: 'default' };
  }
}

function getClaudeVariant(
  permissionMode: PermissionMode,
  modelKey: ModelKey
): string | null {
  if (modelKey === 'opus') return 'OPUS';

  switch (permissionMode) {
    case 'plan':
      return 'PLAN';
    case 'ask':
      return 'APPROVALS';
    case 'auto':
    default:
      return null;
  }
}

type CodexVariantConfig = {
  model: string | null;
  permissionMode: Extract<PermissionMode, 'auto' | 'ask'>;
  variant: string | null;
};

const CODEX_MODEL_LABELS: Record<string, string> = {
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
};

function getVariantRecord(
  profiles: ExecutorConfigs['executors'] | null,
  executor: BaseCodingAgent,
  variant: string | null
): Record<string, unknown> | null {
  const executorProfiles = profiles?.[executor] as Record<string, unknown> | undefined;
  if (!executorProfiles) return null;

  const variantKey = variant ?? 'DEFAULT';
  const variantEntry = executorProfiles[variantKey] as Record<string, unknown> | undefined;
  if (!variantEntry) return null;

  return (variantEntry[executor] as Record<string, unknown> | undefined) ?? null;
}

function getCodexVariantConfig(
  profiles: ExecutorConfigs['executors'] | null,
  variant: string | null
): CodexVariantConfig {
  const record = getVariantRecord(profiles, BaseCodingAgentEnum.CODEX, variant);
  const askForApproval = record?.ask_for_approval;
  const model = typeof record?.model === 'string' ? record.model : null;

  return {
    model,
    permissionMode:
      typeof askForApproval === 'string' && askForApproval !== 'never'
        ? 'ask'
        : 'auto',
    variant,
  };
}

function formatCodexModelLabel(model: string | null): string {
  if (!model) return '默认';
  return CODEX_MODEL_LABELS[model] ?? model;
}

function getCodexModelOptions(
  profiles: ExecutorConfigs['executors'] | null
): CodexModelOption[] {
  const variants = getVariantOptions(BaseCodingAgentEnum.CODEX, profiles);
  const seen = new Set<string>();
  const options: CodexModelOption[] = [];

  for (const variantKey of variants) {
    const variant = variantKey === 'DEFAULT' ? null : variantKey;
    const model = getCodexVariantConfig(profiles, variant).model;
    const modelKey = model ?? 'DEFAULT';
    if (seen.has(modelKey)) continue;

    seen.add(modelKey);
    options.push({
      value: model,
      label: formatCodexModelLabel(model),
    });
  }

  const sortPriority = (value: string | null): number => {
    switch (value) {
      case 'gpt-5.1-codex-max':
        return 0;
      case 'gpt-5.2':
        return 1;
      case 'gpt-5.2-codex':
        return 2;
      case 'gpt-5.3-codex':
        return 3;
      case null:
        return 99;
      default:
        return 50;
    }
  };

  return (options.length > 0
    ? options
    : [{ value: null, label: '默认' }]
  ).sort((a, b) => sortPriority(a.value) - sortPriority(b.value));
}

function getCodexVariantFromSelection(
  profiles: ExecutorConfigs['executors'] | null,
  selectedModel: string | null,
  permissionMode: Extract<PermissionMode, 'auto' | 'ask'>
): string | null {
  const variants = getVariantOptions(BaseCodingAgentEnum.CODEX, profiles);

  const matchedVariant = variants.find((variantKey) => {
    const variant = variantKey === 'DEFAULT' ? null : variantKey;
    const config = getCodexVariantConfig(profiles, variant);
    return config.model === selectedModel && config.permissionMode === permissionMode;
  });

  if (!matchedVariant) {
    return getDefaultVariantForExecutor(BaseCodingAgentEnum.CODEX, profiles);
  }

  return matchedVariant === 'DEFAULT' ? null : matchedVariant;
}

export function TerminalProfileControls({
  profiles,
  selectedProfile,
  onChange,
  disabled,
  className = '',
  lockExecutor = false,
  showLabel = false,
}: TerminalProfileControlsProps) {
  const executor = selectedProfile?.executor ?? null;
  const isClaude = isClaudeCodeExecutor(executor);
  const isCodex = executor === BaseCodingAgentEnum.CODEX;

  const initialClaudeUiState = useMemo(
    () => getClaudeUiState(selectedProfile?.variant),
    [selectedProfile?.variant]
  );

  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>(initialClaudeUiState.permissionMode);
  const [selectedModelKey, setSelectedModelKey] =
    useState<ModelKey>(initialClaudeUiState.modelKey);
  const [codexPermissionMode, setCodexPermissionMode] = useState<
    Extract<PermissionMode, 'auto' | 'ask'>
  >('auto');
  const [selectedCodexModel, setSelectedCodexModel] = useState<string | null>(null);

  const codexModelOptions = useMemo(
    () => getCodexModelOptions(profiles),
    [profiles]
  );

  useEffect(() => {
    if (!isClaude) return;

    const uiState = getClaudeUiState(selectedProfile?.variant);
    setPermissionMode(uiState.permissionMode);
    setSelectedModelKey(uiState.modelKey);
  }, [isClaude, selectedProfile?.variant]);

  useEffect(() => {
    if (!isCodex) return;

    const codexConfig = getCodexVariantConfig(
      profiles,
      selectedProfile?.variant ?? null
    );
    setCodexPermissionMode(codexConfig.permissionMode);
    setSelectedCodexModel(codexConfig.model);
  }, [isCodex, profiles, selectedProfile?.variant]);

  const handleExecutorChange = (nextExecutor: BaseCodingAgent) => {
    const nextProfile = getDefaultProfileForExecutor(nextExecutor, profiles) ?? {
      executor: nextExecutor,
      variant: null,
    };

    if (nextExecutor === BaseCodingAgentEnum.CLAUDE_CODE) {
      onChange({
        executor: nextExecutor,
        variant: getClaudeVariant(permissionMode, selectedModelKey),
      });
      return;
    }

    if (nextExecutor === BaseCodingAgentEnum.CODEX) {
      const variant = getCodexVariantFromSelection(
        profiles,
        selectedCodexModel,
        codexPermissionMode
      );
      onChange({
        executor: nextExecutor,
        variant,
      });
      return;
    }

    onChange(nextProfile);
  };

  const handleClaudeControlChange = (
    nextPermissionMode: PermissionMode,
    nextModelKey: ModelKey
  ) => {
    if (!executor) return;

    onChange({
      executor,
      variant: getClaudeVariant(nextPermissionMode, nextModelKey),
    });
  };

  const handleCodexControlChange = (
    nextPermissionMode: Extract<PermissionMode, 'auto' | 'ask'>,
    nextModel: string | null
  ) => {
    if (!executor) return;

    onChange({
      executor,
      variant: getCodexVariantFromSelection(profiles, nextModel, nextPermissionMode),
    });
  };

  const contentClassName =
    className || 'flex flex-wrap items-center gap-2 flex-1 min-w-0';

  return (
    <div className={contentClassName}>
      {!lockExecutor && (
        <AgentSelector
          profiles={profiles}
          selectedExecutorProfile={selectedProfile}
          onChange={(profile) => handleExecutorChange(profile.executor)}
          disabled={disabled}
          showLabel={showLabel}
          className="flex-1 min-w-0"
        />
      )}

      {isClaude ? (
        <>
          <PermissionSelector
            value={permissionMode}
            onChange={(mode) => {
              setPermissionMode(mode);
              handleClaudeControlChange(mode, selectedModelKey);
            }}
            disabled={disabled}
            className="shrink-0"
          />
          <ModelSelector
            value={selectedModelKey}
            onChange={(modelKey) => {
              setSelectedModelKey(modelKey);
              handleClaudeControlChange(permissionMode, modelKey);
            }}
            disabled={disabled}
            className="max-w-full shrink-0"
          />
        </>
      ) : isCodex ? (
        <>
          <PermissionSelector
            value={codexPermissionMode}
            onChange={(mode) => {
              const nextMode = mode === 'ask' ? 'ask' : 'auto';
              setCodexPermissionMode(nextMode);
              handleCodexControlChange(nextMode, selectedCodexModel);
            }}
            modes={['auto', 'ask']}
            disabled={disabled}
            className="shrink-0"
          />
          <CodexModelSelector
            value={selectedCodexModel}
            options={codexModelOptions}
            onChange={(model) => {
              setSelectedCodexModel(model);
              handleCodexControlChange(codexPermissionMode, model);
            }}
            disabled={disabled}
            className="max-w-full shrink-0"
          />
        </>
      ) : (
        <ConfigSelector
          profiles={profiles}
          selectedExecutorProfile={selectedProfile}
          onChange={onChange}
          disabled={disabled}
          showLabel={showLabel && lockExecutor}
          className={lockExecutor ? 'flex-1 min-w-0' : ''}
        />
      )}
    </div>
  );
}
