import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Bug,
  Code2,
  Eye,
  History,
  Lightbulb,
  Loader2,
  RefreshCw,
  Terminal,
  Type,
  Volume2,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { SoundFile, type Config, type LinkOpenBehavior } from 'shared/types';

import { ExternalEditorPicker } from '@/components/settings/ExternalEditorPicker';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { configApi } from '@/lib/api';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
} from '@/lib/terminalPreferences';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';
import { toPrettyCase } from '@/utils/string';
import { SettingsActionBar, SettingsSection } from './SettingsUi';

const DEFAULT_PROMPT_ENHANCEMENT_PROMPT = `You are PromptEnhance (PE).

Your job is to rewrite the user's draft prompt into a clearer, tighter, more actionable prompt.

Rules:
1. Be fast: do not explain your reasoning, just produce the optimized prompt.
2. Be accurate: use the recent conversation context only when it materially improves the prompt.
3. Optimize the prompt itself, not the conversation summary.
4. Do not echo or expose session context unless the user's prompt is clearly ambiguous without it.
5. Do not add sections like "related context" unless absolutely necessary.
6. Follow basic prompt design principles: clearly state the task, goal, constraints, and any helpful decomposition.
7. Avoid bloated prompt frameworks, unnecessary ceremony, and redundant wording.
8. Keep the user's original intent unchanged.
9. Output JSON only, with exactly one top-level field named EnhancedPrompt.
10. Do not return Markdown fences, commentary, or any extra fields.

Output shape:
{"EnhancedPrompt":"..."}`;

function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

export function GeneralSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, loading, updateAndSaveConfig } = useUserSystem();

  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewFontSize = useEditorSettingsStore(
    (state) => state.previewFontSize
  );
  const setPreviewFontSize = useEditorSettingsStore(
    (state) => state.setPreviewFontSize
  );

  const [agentModels, setAgentModels] = useState<string[]>([]);
  const [agentModelsLoading, setAgentModelsLoading] = useState(false);
  const agentModelsRequestIdRef = useRef(0);
  const startupCatalogRetriesEnabledRef = useRef(true);

  useEffect(() => {
    if (config && !dirty) {
      setDraft(cloneConfig(config));
    }
  }, [config, dirty]);

  const updateDraft = useCallback((patch: Partial<Config>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return { ...prev, ...patch };
    });
  }, []);

  const readPersistedAgentModels = useCallback(async () => {
    const requestId = ++agentModelsRequestIdRef.current;
    try {
      const result = await configApi.listPromptEnhancementModels();
      if (requestId === agentModelsRequestIdRef.current) {
        setAgentModels(result.models);
      }
      return result.models;
    } catch {
      return null;
    }
  }, []);

  // A normal settings visit only reads the same fingerprint-matching catalog
  // that session creation uses. It never starts an Agent process. If
  // startup warmup is still completing, retry the local catalog read for a
  // short, bounded window rather than polling forever on an absent runtime.
  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let retryAttempts = 0;
    const maxStartupCatalogRetries = 10;

    const loadCatalog = async () => {
      if (disposed || !startupCatalogRetriesEnabledRef.current) return;
      const models = await readPersistedAgentModels();
      if (
        !disposed &&
        startupCatalogRetriesEnabledRef.current &&
        models?.length === 0 &&
        retryAttempts < maxStartupCatalogRetries
      ) {
        retryAttempts += 1;
        retryTimer = window.setTimeout(() => {
          void loadCatalog();
        }, 1000);
      }
    };

    void loadCatalog();
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [readPersistedAgentModels]);

  const refreshAgentModels = useCallback(async () => {
    setAgentModelsLoading(true);
    startupCatalogRetriesEnabledRef.current = false;
    const requestId = ++agentModelsRequestIdRef.current;
    try {
      // This is the only user-initiated path allowed to refresh discovery. The
      // backend uses each eligible Agent's verified local Runtime/ACP pair.
      const refreshed = await configApi.refreshPromptEnhancementModels();
      if (!refreshed.models.length) {
        toast.error(t('general.modelsRefreshFailed'));
        return;
      }
      if (requestId === agentModelsRequestIdRef.current) {
        setAgentModels(refreshed.models);
      }
      toast.success(t('general.modelsRefreshed'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('general.modelsRefreshFailed')
      );
    } finally {
      setAgentModelsLoading(false);
    }
  }, [t]);

  const promptEnhancementModels = useMemo(() => {
    const uniqueModels: string[] = [];

    for (const model of agentModels) {
      if (model && !uniqueModels.includes(model)) {
        uniqueModels.push(model);
      }
    }

    return uniqueModels.sort((a, b) => a.localeCompare(b));
  }, [agentModels]);
  const currentPromptEnhancementModel =
    draft?.prompt_enhancement_model?.trim() ?? '';
  const currentPromptEnhancementModelAvailable =
    currentPromptEnhancementModel.length > 0 &&
    promptEnhancementModels.includes(currentPromptEnhancementModel);

  const playSound = async (soundFile: SoundFile) => {
    try {
      await configApi.playNotificationSound(soundFile);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    try {
      setSaving(true);
      const saved = await updateAndSaveConfig(draft);
      if (!saved) {
        throw new Error(t('general.saveGeneralFailed'));
      }
      setDirty(false);
      toast.success(t('general.settingsSaved'), {
        description: t('general.generalSettingsUpdated'),
      });
    } catch (error) {
      toast.error(t('general.saveFailed'), {
        description:
          error instanceof Error
            ? error.message
            : t('general.saveGeneralFailed'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!config) return;
    setDraft(cloneConfig(config));
    setDirty(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!draft) {
    return null;
  }

  const terminalShellOptions = getTerminalShellOptions();

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={Terminal}
          title={t('general.terminalTitle')}
          description={t('general.terminalDescription')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('general.defaultTerminal')}</Label>
              <p className="settings-row__description">
                {t('general.defaultTerminalDescription')}
              </p>
            </div>
            <Select
              value={getDefaultTerminalShell(draft)}
              onValueChange={(value) =>
                updateDraft({ default_terminal_shell: value })
              }
            >
              <SelectTrigger className="!w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {terminalShellOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Code2}
          title={t('general.externalEditorTitle')}
          description={t('general.externalEditorDescription')}
        >
          <ExternalEditorPicker
            value={draft.editor}
            onChange={(editor) => updateDraft({ editor })}
          />
        </SettingsSection>

        <SettingsSection
          icon={Lightbulb}
          title={t('general.promptEnhancementTitle')}
          description={t('general.promptEnhancementDescription')}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="prompt-enhancement-enabled"
                  className="cursor-pointer text-xs"
                >
                  {t('general.enablePromptEnhancement')}
                </Label>
                <Switch
                  id="prompt-enhancement-enabled"
                  className="settings-switch"
                  checked={draft.prompt_enhancement_enabled ?? false}
                  onCheckedChange={(checked: boolean) =>
                    updateDraft({ prompt_enhancement_enabled: checked })
                  }
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('general.enablePromptEnhancementHint')}
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <Label className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t('general.promptEnhancementModel')}
                </Label>
                <div className="flex items-center justify-end gap-2">
                  <Select
                    value={
                      currentPromptEnhancementModelAvailable
                        ? currentPromptEnhancementModel
                        : undefined
                    }
                    onValueChange={(value: string) =>
                      updateDraft({ prompt_enhancement_model: value })
                    }
                    disabled={promptEnhancementModels.length === 0}
                  >
                    <SelectTrigger
                      className="!w-72"
                      aria-label={t('general.promptEnhancementModel')}
                    >
                      <SelectValue
                        placeholder={t('general.selectModelPlaceholder')}
                      />
                    </SelectTrigger>
                    <SelectContent align="start" className="max-h-72">
                      {promptEnhancementModels.map((model) => {
                        return (
                          <SelectItem
                            key={model}
                            value={model}
                            textValue={model}
                          >
                            <span className="truncate">{model}</span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => void refreshAgentModels()}
                    disabled={agentModelsLoading}
                    title={t('general.refreshModels')}
                    aria-label={t('general.refreshModels')}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${
                        agentModelsLoading ? 'animate-spin' : ''
                      }`}
                    />
                  </Button>
                </div>
              </div>
              {currentPromptEnhancementModel &&
              !currentPromptEnhancementModelAvailable ? (
                <p className="text-right text-[11px] text-muted-foreground">
                  {t('general.currentModelUnavailable', {
                    model: currentPromptEnhancementModel,
                  })}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="use-custom-pe-prompt"
                  className="cursor-pointer text-xs"
                >
                  {t('general.useCustomPrompt')}
                </Label>
                <Switch
                  id="use-custom-pe-prompt"
                  className="settings-switch"
                  checked={draft.prompt_enhancement_prompt != null}
                  onCheckedChange={(checked: boolean) =>
                    updateDraft({
                      prompt_enhancement_prompt: checked
                        ? DEFAULT_PROMPT_ENHANCEMENT_PROMPT
                        : null,
                    })
                  }
                />
              </div>
              <Textarea
                value={
                  draft.prompt_enhancement_prompt ??
                  DEFAULT_PROMPT_ENHANCEMENT_PROMPT
                }
                disabled={draft.prompt_enhancement_prompt == null}
                onChange={(event) =>
                  updateDraft({
                    prompt_enhancement_prompt: event.target.value,
                  })
                }
                placeholder={t('general.customPromptPlaceholder')}
                className={`min-h-32 font-mono text-xs ${
                  draft.prompt_enhancement_prompt == null
                    ? 'cursor-not-allowed opacity-50'
                    : ''
                }`}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('general.customPromptHint')}
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={History}
          title={t('general.sessionContinuationTitle')}
          description={t('general.sessionContinuationDescription')}
        >
          <div className="settings-row">
            <div>
              <Label
                htmlFor="previous-session-continuation-enabled"
                className="cursor-pointer"
              >
                {t('general.enablePreviousSessionContinuation')}
              </Label>
              <p className="settings-row__description">
                {t('general.enablePreviousSessionContinuationHint')}
              </p>
            </div>
            <Switch
              id="previous-session-continuation-enabled"
              className="settings-switch"
              checked={draft.previous_session_continuation_enabled ?? false}
              onCheckedChange={(checked: boolean) =>
                updateDraft({ previous_session_continuation_enabled: checked })
              }
            />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bell}
          title={t('general.notificationsTitle')}
          description={t('general.notificationsDescription')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="sound-enabled" className="cursor-pointer text-xs">
                {t('general.soundNotification')}
              </Label>
              <Switch
                id="sound-enabled"
                className="settings-switch"
                checked={draft.notifications.sound_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    notifications: {
                      ...draft.notifications,
                      sound_enabled: checked,
                    },
                  })
                }
              />
            </div>

            {draft.notifications.sound_enabled ? (
              <div className="flex items-center justify-between gap-4">
                <Label className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t('general.sound')}
                </Label>
                <div className="flex items-center justify-end gap-2">
                  <Select
                    value={draft.notifications.sound_file}
                    onValueChange={(value: SoundFile) =>
                      updateDraft({
                        notifications: {
                          ...draft.notifications,
                          sound_file: value,
                        },
                      })
                    }
                  >
                    <SelectTrigger className="!w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {Object.values(SoundFile).map((soundFile) => (
                        <SelectItem key={soundFile} value={soundFile}>
                          {toPrettyCase(soundFile)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => playSound(draft.notifications.sound_file)}
                  >
                    <Volume2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="push-notifications"
                className="cursor-pointer text-xs"
              >
                {t('general.pushNotification')}
              </Label>
              <Switch
                id="push-notifications"
                className="settings-switch"
                checked={draft.notifications.push_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({
                    notifications: {
                      ...draft.notifications,
                      push_enabled: checked,
                    },
                  })
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bug}
          title={t('general.crashReportsTitle')}
          description={t('general.crashReportsDescription')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <Label
                htmlFor="crash-reports-enabled"
                className="cursor-pointer text-xs"
              >
                {t('general.crashReportsToggle')}
              </Label>
              <Switch
                id="crash-reports-enabled"
                className="settings-switch"
                checked={draft.crash_reports_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ crash_reports_enabled: checked })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('general.crashReportsPrivacy')}
            </p>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Eye}
          title={t('general.previewTitle')}
          description={t('general.previewDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div className="flex items-center gap-2">
                <Type className="h-3.5 w-3.5 text-muted-foreground" />
                <div>
                  <Label>{t('general.previewFontSize')}</Label>
                  <p className="settings-row__description">
                    {t('general.currentFontSize', { size: previewFontSize })}
                  </p>
                </div>
              </div>
              <div className="settings-inline-group">
                <Input
                  type="number"
                  min={10}
                  max={24}
                  value={previewFontSize}
                  onChange={(event) =>
                    setPreviewFontSize(Number(event.target.value))
                  }
                  className="w-24"
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.filesChangedCollapsed')}</Label>
                <p className="settings-row__description">
                  {t('general.filesChangedCollapsedHint')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                aria-label={t('general.filesChangedCollapsed')}
                checked={draft.files_changed_default_collapsed ?? true}
                onCheckedChange={(checked) =>
                  updateDraft({ files_changed_default_collapsed: checked })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.linkOpenBehavior')}</Label>
                <p className="settings-row__description">
                  {t('general.linkOpenBehaviorHint')}
                </p>
              </div>
              <Select
                value={draft.link_open_behavior ?? 'ExternalBrowser'}
                onValueChange={(value: LinkOpenBehavior) =>
                  updateDraft({ link_open_behavior: value })
                }
              >
                <SelectTrigger className="!w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="ExternalBrowser">
                    {t('general.linkOpenExternal')}
                  </SelectItem>
                  <SelectItem value="BuiltinPreview">
                    {t('general.linkOpenBuiltin')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.aiMessageCollapsed')}</Label>
                <p className="settings-row__description">
                  {t('general.aiMessageCollapsedHint')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                aria-label={t('general.aiMessageCollapsed')}
                checked={draft.ai_message_default_collapsed ?? true}
                onCheckedChange={(checked) =>
                  updateDraft({ ai_message_default_collapsed: checked })
                }
              />
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={handleReset}
        onSave={handleSave}
      />
    </div>
  );
}
