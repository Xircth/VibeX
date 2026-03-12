/**
 * Agent Settings page.
 *
 * Two-card layout:
 * 1. Default coding agent selector (top card)
 * 2. Agent configuration with left-right dual-panel layout (bottom card)
 *    - Left panel: agent list (Claude Code, Codex, OpenCode)
 *    - Right panel: per-agent customized form + configuration selector
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloneDeep, isEqual } from 'lodash';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { ChevronDown, Loader2, Save } from 'lucide-react';

import { useProfiles } from '@/hooks/useProfiles';
import { useUserSystem } from '@/components/ConfigProvider';
import { useAgentNativeConfig } from '@/hooks/useAgentNativeConfig';
import { CreateConfigurationDialog } from '@/components/dialogs/settings/CreateConfigurationDialog';
import { DeleteConfigurationDialog } from '@/components/dialogs/settings/DeleteConfigurationDialog';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { AgentAvailabilityIndicator } from '@/components/AgentAvailabilityIndicator';

import {
  SUPPORTED_AGENTS,
  AGENT_DISPLAY_NAMES,
  AGENT_DESCRIPTIONS,
  isSupportedAgent,
} from '@/constants/agents';
import type { SupportedAgent } from '@/constants/agents';
import {
  buildDraftFromProfile,
  buildProfileConfigFromDraft,
  createEmptyDraft,
} from '@/lib/agentConfigUtils';
import type { AgentDraft } from '@/lib/agentConfigUtils';

import {
  ClaudeCodeForm,
  CodexForm,
  OpenCodeForm,
} from '@/components/settings/agent-forms';

import type {
  BaseCodingAgent,
  ExecutorConfigs,
  ExecutorProfileId,
} from 'shared/types';

import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecutorsMap = Record<string, Record<string, Record<string, unknown>>>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentSettings() {
  // ── Hooks ───────────────────────────────────────────────────────────────
  const {
    parsedProfiles: serverParsedProfiles,
    profilesPath,
    isLoading: profilesLoading,
    isSaving: profilesSaving,
    error: profilesError,
    save: saveProfiles,
  } = useProfiles();

  const { config, updateAndSaveConfig, profiles, reloadSystem } =
    useUserSystem();

  // ── State: Default agent selector (Card 1) ─────────────────────────────
  const [executorDraft, setExecutorDraft] = useState<ExecutorProfileId | null>(
    () => (config?.executor_profile ? cloneDeep(config.executor_profile) : null)
  );
  const [executorSaving, setExecutorSaving] = useState(false);
  const [executorSuccess, setExecutorSuccess] = useState(false);
  const [executorError, setExecutorError] = useState<string | null>(null);

  const agentAvailability = useAgentAvailability(executorDraft?.executor);

  // ── State: Agent configuration (Card 2) ─────────────────────────────────
  const [selectedAgentType, setSelectedAgentType] = useState<SupportedAgent>(
    'CLAUDE_CODE' as SupportedAgent
  );
  const [selectedConfiguration, setSelectedConfiguration] = useState('DEFAULT');
  const [localParsedProfiles, setLocalParsedProfiles] =
    useState<ExecutorConfigs | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(createEmptyDraft);
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profilesSuccess, setProfilesSuccess] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);

  // Native config for the selected agent
  const nativeConfig = useAgentNativeConfig(selectedAgentType);

  // ── Sync server profiles to local state ────────────────────────────────
  useEffect(() => {
    if (!isDirty && serverParsedProfiles) {
      setLocalParsedProfiles(serverParsedProfiles as ExecutorConfigs);
    }
  }, [serverParsedProfiles, isDirty]);

  // ── Sync executor draft ────────────────────────────────────────────────
  useEffect(() => {
    if (config?.executor_profile) {
      setExecutorDraft((currentDraft) => {
        if (!currentDraft || isEqual(currentDraft, config.executor_profile)) {
          return cloneDeep(config.executor_profile);
        }
        return currentDraft;
      });
    }
  }, [config?.executor_profile]);

  // ── Build draft when agent/config/nativeConfig changes ─────────────────
  useEffect(() => {
    if (!localParsedProfiles?.executors || isDirty) return;

    const executorsMap =
      localParsedProfiles.executors as unknown as ExecutorsMap;
    const agentConfig =
      executorsMap[selectedAgentType]?.[selectedConfiguration]?.[
        selectedAgentType
      ];

    if (!agentConfig) return;

    const newDraft = buildDraftFromProfile(
      selectedAgentType as BaseCodingAgent,
      agentConfig as Record<string, unknown>,
      nativeConfig.data
    );

    setDraft(newDraft);
  }, [
    localParsedProfiles,
    selectedAgentType,
    selectedConfiguration,
    nativeConfig.data,
    isDirty,
  ]);

  // ── Draft change handler ───────────────────────────────────────────────
  const handleDraftChange = useCallback((patch: Partial<AgentDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setIsDirty(true);
  }, []);

  // ── Available configurations for selected agent ────────────────────────
  const configurationOptions = useMemo(() => {
    if (!localParsedProfiles?.executors) return [];
    return Object.keys(
      localParsedProfiles.executors[selectedAgentType] ?? {}
    );
  }, [localParsedProfiles, selectedAgentType]);

  // ── Save executor profile (Card 1) ────────────────────────────────────
  const executorDirty =
    executorDraft && config?.executor_profile
      ? !isEqual(executorDraft, config.executor_profile)
      : false;

  const handleSaveExecutorProfile = async () => {
    if (!executorDraft || !config) return;

    setExecutorSaving(true);
    setExecutorError(null);

    try {
      const saved = await updateAndSaveConfig({
        executor_profile: executorDraft,
      });
      if (!saved) {
        setExecutorError('保存配置失败');
        return;
      }
      setExecutorSuccess(true);
      setTimeout(() => setExecutorSuccess(false), 3000);
      reloadSystem();
    } catch {
      setExecutorError('保存配置失败');
    } finally {
      setExecutorSaving(false);
    }
  };

  // ── Save agent configuration (Card 2) ──────────────────────────────────
  const handleSaveAgentConfig = async () => {
    if (!localParsedProfiles?.executors) return;

    setSaveError(null);

    try {
      // 1. Build the profile config from the draft
      const executorsMap =
        localParsedProfiles.executors as unknown as ExecutorsMap;
      const existingConfig =
        (executorsMap[selectedAgentType]?.[selectedConfiguration]?.[
          selectedAgentType
        ] as Record<string, unknown>) ?? {};

      const updatedConfig = buildProfileConfigFromDraft(
        selectedAgentType as BaseCodingAgent,
        draft,
        existingConfig
      );

      // 2. Update profiles.json
      const updatedProfiles = {
        ...localParsedProfiles,
        executors: {
          ...localParsedProfiles.executors,
          [selectedAgentType]: {
            ...executorsMap[selectedAgentType],
            [selectedConfiguration]: {
              [selectedAgentType]: updatedConfig,
            },
          },
        },
      };

      await saveProfiles(JSON.stringify(updatedProfiles, null, 2));
      setLocalParsedProfiles(updatedProfiles as ExecutorConfigs);

      // 3. Save native config files (Codex / OpenCode)
      if (selectedAgentType === 'CODEX') {
        await nativeConfig.save({
          codexConfigToml: draft.codexConfigTomlText || null,
          codexAuthJson: draft.codexAuthJsonText || null,
        });
      } else if (selectedAgentType === 'OPENCODE') {
        await nativeConfig.save({
          opencodeConfigJson: draft.openCodeConfigText || null,
          opencodeAuthJson: draft.openCodeAuthJsonText || null,
        });
      }

      setIsDirty(false);
      setProfilesSuccess(true);
      setTimeout(() => setProfilesSuccess(false), 3000);
      reloadSystem();
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存配置失败';
      setSaveError(message);
    }
  };

  // ── Agent selection handler ────────────────────────────────────────────
  const handleSelectAgent = (agent: SupportedAgent) => {
    if (agent === selectedAgentType) return;
    setSelectedAgentType(agent);
    setSelectedConfiguration('DEFAULT');
    setIsDirty(false);
  };

  // ── Create / Delete configuration handlers ─────────────────────────────
  const openCreateDialog = async () => {
    try {
      const result = await CreateConfigurationDialog.show({
        executorType: selectedAgentType as BaseCodingAgent,
        existingConfigs: configurationOptions,
      });

      if (result.action === 'created' && result.configName) {
        createConfiguration(result.configName, result.cloneFrom);
      }
    } catch {
      // User cancelled
    }
  };

  const createConfiguration = (
    configName: string,
    baseConfig?: string | null
  ) => {
    if (!localParsedProfiles?.executors) return;

    const executorsMap =
      localParsedProfiles.executors as unknown as ExecutorsMap;
    const base =
      baseConfig &&
      executorsMap[selectedAgentType]?.[baseConfig]?.[selectedAgentType]
        ? executorsMap[selectedAgentType][baseConfig][selectedAgentType]
        : {};

    const updatedProfiles = {
      ...localParsedProfiles,
      executors: {
        ...localParsedProfiles.executors,
        [selectedAgentType]: {
          ...executorsMap[selectedAgentType],
          [configName]: {
            [selectedAgentType]: base,
          },
        },
      },
    };

    setLocalParsedProfiles(updatedProfiles as ExecutorConfigs);
    setSelectedConfiguration(configName);
    setIsDirty(true);
  };

  const openDeleteDialog = async (configName: string) => {
    try {
      const result = await DeleteConfigurationDialog.show({
        configName,
        executorType: selectedAgentType as BaseCodingAgent,
      });

      if (result === 'deleted') {
        await handleDeleteConfiguration(configName);
      }
    } catch {
      // User cancelled
    }
  };

  const handleDeleteConfiguration = async (configToDelete: string) => {
    if (!localParsedProfiles?.executors) return;

    if (!localParsedProfiles.executors[selectedAgentType]?.[configToDelete]) {
      return;
    }

    const currentConfigs = Object.keys(
      localParsedProfiles.executors[selectedAgentType] ?? {}
    );
    if (currentConfigs.length <= 1) return;

    const remainingConfigs = {
      ...localParsedProfiles.executors[selectedAgentType],
    };
    delete remainingConfigs[configToDelete];

    const updatedProfiles = {
      ...localParsedProfiles,
      executors: {
        ...localParsedProfiles.executors,
        [selectedAgentType]: remainingConfigs,
      },
    };

    try {
      await saveProfiles(JSON.stringify(updatedProfiles, null, 2));
      setLocalParsedProfiles(updatedProfiles as ExecutorConfigs);
      setIsDirty(false);

      const nextConfigs = Object.keys(remainingConfigs);
      setSelectedConfiguration(nextConfigs[0] ?? 'DEFAULT');

      setProfilesSuccess(true);
      setTimeout(() => setProfilesSuccess(false), 3000);
      reloadSystem();
    } catch {
      setSaveError('删除配置失败');
    }
  };

  // ── Loading state ──────────────────────────────────────────────────────
  if (profilesLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="ml-2">加载代理配置中...</span>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Status alerts */}
      {!!profilesError && (
        <Alert variant="destructive">
          <AlertDescription>
            {profilesError instanceof Error
              ? profilesError.message
              : String(profilesError)}
          </AlertDescription>
        </Alert>
      )}
      {profilesSuccess && (
        <Alert variant="success">
          <AlertDescription className="font-medium">
            配置保存成功
          </AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {executorError && (
        <Alert variant="destructive">
          <AlertDescription>{executorError}</AlertDescription>
        </Alert>
      )}
      {executorSuccess && (
        <Alert variant="success">
          <AlertDescription className="font-medium">
            设置保存成功
          </AlertDescription>
        </Alert>
      )}

      {/* ─── Card 1: Default Coding Agent ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>默认编码代理</CardTitle>
          <CardDescription>选择任务的默认编码代理。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="executor">默认代理配置</Label>
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={executorDraft?.executor ?? ''}
                onValueChange={(value: string) => {
                  const variants = profiles?.[value];
                  const keepCurrentVariant =
                    variants &&
                    executorDraft?.variant &&
                    variants[executorDraft.variant];

                  const newProfile: ExecutorProfileId = {
                    executor: value as BaseCodingAgent,
                    variant: keepCurrentVariant
                      ? executorDraft!.variant
                      : null,
                  };
                  setExecutorDraft(newProfile);
                }}
                disabled={!profiles}
              >
                <SelectTrigger id="executor">
                  <SelectValue placeholder="选择配置文件" />
                </SelectTrigger>
                <SelectContent>
                  {profiles &&
                    Object.entries(profiles)
                      .filter(([key]) => isSupportedAgent(key))
                      .sort((a, b) => a[0].localeCompare(b[0]))
                      .map(([profileKey]) => (
                        <SelectItem key={profileKey} value={profileKey}>
                          {(AGENT_DISPLAY_NAMES as Record<string, string>)[
                            profileKey
                          ] ?? profileKey}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>

              {/* Variant selector */}
              {(() => {
                const selectedProfile =
                  profiles?.[executorDraft?.executor ?? ''];
                const hasVariants =
                  selectedProfile &&
                  Object.keys(selectedProfile).length > 0;

                if (hasVariants) {
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="w-full h-10 px-2 flex items-center justify-between"
                        >
                          <span className="text-sm truncate flex-1 text-left">
                            {executorDraft?.variant ?? '默认'}
                          </span>
                          <ChevronDown className="h-4 w-4 ml-1 flex-shrink-0" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {Object.entries(selectedProfile).map(
                          ([variantLabel]) => (
                            <DropdownMenuItem
                              key={variantLabel}
                              onClick={() => {
                                setExecutorDraft({
                                  executor: executorDraft!.executor,
                                  variant: variantLabel,
                                });
                              }}
                              className={
                                executorDraft?.variant === variantLabel
                                  ? 'bg-accent text-accent-foreground'
                                  : ''
                              }
                            >
                              {variantLabel}
                            </DropdownMenuItem>
                          )
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                }

                if (selectedProfile) {
                  return (
                    <Button
                      variant="outline"
                      className="w-full h-10 px-2 flex items-center justify-between"
                      disabled
                    >
                      <span className="text-sm truncate flex-1 text-left">
                        默认
                      </span>
                    </Button>
                  );
                }
                return null;
              })()}
            </div>
            <AgentAvailabilityIndicator availability={agentAvailability} />
            <p className="text-sm text-muted-foreground">
              选择创建任务尝试时使用的默认代理配置。
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleSaveExecutorProfile}
              disabled={!executorDirty || executorSaving}
            >
              {executorSaving && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─── Card 2: Agent Configuration (Dual Panel) ─────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>编码代理配置</CardTitle>
          <CardDescription>
            使用不同的配置自定义编码代理的行为。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {localParsedProfiles?.executors ? (
            <div className="flex gap-6 min-h-[400px]">
              {/* ── Left Panel: Agent List ─────────────────────────────── */}
              <div className="w-48 flex-shrink-0 space-y-1 border-r pr-4">
                {SUPPORTED_AGENTS.map((agent) => {
                  const isSelected = agent === selectedAgentType;
                  const displayName =
                    (AGENT_DISPLAY_NAMES as Record<string, string>)[
                      agent
                    ] ?? agent;

                  return (
                    <button
                      key={agent}
                      type="button"
                      onClick={() =>
                        handleSelectAgent(agent as SupportedAgent)
                      }
                      className={cn(
                        'w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors',
                        isSelected
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      {displayName}
                    </button>
                  );
                })}
              </div>

              {/* ── Right Panel: Configuration Details ─────────────────── */}
              <div className="flex-1 min-w-0 space-y-6">
                {/* Agent header */}
                <div>
                  <h3 className="text-lg font-semibold">
                    {(AGENT_DISPLAY_NAMES as Record<string, string>)[
                      selectedAgentType
                    ] ?? selectedAgentType}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {(AGENT_DESCRIPTIONS as Record<string, string>)[
                      selectedAgentType
                    ] ?? ''}
                  </p>
                </div>

                {/* Configuration selector */}
                <div className="space-y-2">
                  <Label>配置</Label>
                  <div className="flex gap-2">
                    <Select
                      value={selectedConfiguration}
                      onValueChange={(value) => {
                        if (value === '__create__') {
                          openCreateDialog();
                        } else {
                          setSelectedConfiguration(value);
                          setIsDirty(false);
                        }
                      }}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="选择配置" />
                      </SelectTrigger>
                      <SelectContent>
                        {configurationOptions.map((cfg) => (
                          <SelectItem key={cfg} value={cfg}>
                            {cfg}
                          </SelectItem>
                        ))}
                        <SelectItem value="__create__">
                          新建...
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-10"
                      onClick={() =>
                        openDeleteDialog(selectedConfiguration)
                      }
                      disabled={
                        profilesSaving ||
                        configurationOptions.length <= 1
                      }
                      title={
                        configurationOptions.length <= 1
                          ? '无法删除最后一个配置'
                          : `删除 ${selectedConfiguration}`
                      }
                    >
                      删除
                    </Button>
                  </div>
                </div>

                {/* Divider */}
                <div className="border-t" />

                {/* Native config loading state */}
                {nativeConfig.isLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载原生配置...
                  </div>
                )}

                {/* Custom form based on agent type */}
                {!nativeConfig.isLoading && (
                  <>
                    {selectedAgentType === 'CLAUDE_CODE' && (
                      <ClaudeCodeForm
                        draft={draft}
                        onDraftChange={handleDraftChange}
                        disabled={
                          profilesSaving || nativeConfig.isSaving
                        }
                      />
                    )}
                    {selectedAgentType === 'CODEX' && (
                      <CodexForm
                        draft={draft}
                        onDraftChange={handleDraftChange}
                        disabled={
                          profilesSaving || nativeConfig.isSaving
                        }
                      />
                    )}
                    {selectedAgentType === 'OPENCODE' && (
                      <OpenCodeForm
                        draft={draft}
                        onDraftChange={handleDraftChange}
                        disabled={
                          profilesSaving || nativeConfig.isSaving
                        }
                      />
                    )}

                    {/* Raw JSON toggle */}
                    <div className="border-t pt-4">
                      <button
                        type="button"
                        onClick={() => setShowRawJson((p) => !p)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showRawJson
                          ? '隐藏原始 JSON'
                          : '显示原始 JSON'}
                      </button>
                      {showRawJson && (
                        <div className="mt-2 space-y-2">
                          <Label className="text-xs">
                            Raw Configuration (JSON)
                          </Label>
                          <Textarea
                            value={draft.configText}
                            onChange={(e) =>
                              handleDraftChange({
                                configText: e.target.value,
                              })
                            }
                            className="font-mono text-xs min-h-[120px]"
                            disabled={profilesSaving}
                          />
                          {profilesPath && (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-medium">
                                配置文件：
                              </span>{' '}
                              <span className="font-mono">
                                {profilesPath}
                              </span>
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Save button */}
                <div className="flex justify-end pt-2">
                  <Button
                    onClick={handleSaveAgentConfig}
                    disabled={
                      !isDirty ||
                      profilesSaving ||
                      nativeConfig.isSaving
                    }
                  >
                    {(profilesSaving || nativeConfig.isSaving) && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    <Save className="mr-2 h-4 w-4" />
                    保存配置
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-4">
              无法加载代理配置。请检查 profiles.json 文件。
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
