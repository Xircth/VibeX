import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  History,
  Lightbulb,
  Loader2,
  Terminal,
  Volume2,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import { SoundFile, type Config, type NotificationWhen } from 'shared/types';

import { PluginSettingsSections } from '@/components/plugins/PluginSettingsSections';
import { ImportLocalSessionsDialog } from '@/components/sessions/ImportLocalSessionsDialog';
import { LocalHistoryImportStatus } from '@/features/history-import/LocalHistoryImportStatus';
import { useLocalHistoryImportJob } from '@/features/history-import/useLocalHistoryImportJob';
import { AgentSessionConfigPicker } from '@/components/settings/AgentSessionConfigPicker';
import { ExternalEditorPicker } from '@/components/settings/ExternalEditorPicker';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
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
import { useLocalDesktopHost } from '@/lib/desktopShell';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
} from '@/lib/terminalPreferences';
import { terminalHostPlatform } from '@/utils/platform';
import { toPrettyCase } from '@/utils/string';
import { useOptionalBasicGuide } from '@/features/basic-guide';
import { restartBasicGuide } from '@/features/basic-guide/basicGuideState';
import { writeBasicGuide } from '@/features/basic-guide/basicGuideStorage';
import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';

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
  const { config, environment, loading, updateAndSaveConfig } = useUserSystem();
  const basicGuide = useOptionalBasicGuide();
  const localDesktopHost = useLocalDesktopHost();

  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [importOpen, setImportOpen] = useState(false);
  const importJob = useLocalHistoryImportJob();

  const { writeNow, writeSettled, flush, holding } = useLiveSettingsCommit(
    async (next: Config) => {
      const saved = await updateAndSaveConfig(next);
      if (!saved) {
        toast.error(t('general.saveFailed'), {
          description: t('general.saveGeneralFailed'),
        });
      }
    }
  );

  const appliedConfig = useRef(config);
  useEffect(() => {
    if (!config || holding) return;
    if (config === appliedConfig.current) return;
    appliedConfig.current = config;
    const next = cloneConfig(config);
    draftRef.current = next;
    setDraft(next);
  }, [config, holding]);

  const updateDraft = useCallback(
    (patch: Partial<Config>, settle = false) => {
      const previous = draftRef.current;
      if (!previous) return;
      const next = { ...previous, ...patch };
      draftRef.current = next;
      setDraft(next);
      if (settle) writeSettled(next);
      else writeNow(next);
    },
    [writeNow, writeSettled]
  );

  const playSound = async (soundFile: SoundFile) => {
    try {
      await configApi.playNotificationSound(soundFile);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
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

  const hostPlatform = terminalHostPlatform(environment?.os_type);
  const terminalShellOptions = getTerminalShellOptions(hostPlatform);

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={Terminal}
          title={t('general.basicFeaturesTitle')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('general.defaultTerminal')}</Label>
                <p className="settings-row__description">
                  {t('general.defaultTerminalDescription')}
                </p>
              </div>
              <Select
                value={getDefaultTerminalShell(draft, environment?.os_type)}
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

            {localDesktopHost ? (
              <ExternalEditorPicker
                value={draft.editor}
                onChange={(editor) => updateDraft({ editor })}
              />
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Lightbulb}
          title={t('general.utilityFeaturesTitle')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label
                  htmlFor="prompt-enhancement-enabled"
                  className="cursor-pointer"
                >
                  {t('general.enablePromptEnhancement')}
                </Label>
                <p className="settings-row__description">
                  {t('general.enablePromptEnhancementHint')}
                </p>
              </div>
              <Switch
                id="prompt-enhancement-enabled"
                className="settings-switch"
                checked={draft.prompt_enhancement_enabled ?? false}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ prompt_enhancement_enabled: checked })
                }
              />
            </div>

            {draft.prompt_enhancement_enabled ? (
              <>
                <AgentSessionConfigPicker
                  agentId={draft.prompt_enhancement_agent_id ?? ''}
                  selectedModeId={draft.prompt_enhancement_mode ?? null}
                  pendingConfigValues={
                    draft.prompt_enhancement_session_config as Record<
                      string,
                      string
                    >
                  }
                  agentLabel={t('general.promptEnhancementAgent')}
                  onAgentChange={(value) =>
                    updateDraft({
                      prompt_enhancement_agent_id: value,
                      prompt_enhancement_mode: null,
                      prompt_enhancement_session_config: {},
                    })
                  }
                  onSelectMode={(modeId) =>
                    updateDraft({ prompt_enhancement_mode: modeId })
                  }
                  onSelectConfigValue={(key, value) =>
                    updateDraft({
                      prompt_enhancement_session_config: {
                        ...draft.prompt_enhancement_session_config,
                        [key]: value,
                      },
                    })
                  }
                />

                <div className="space-y-2">
                  <div className="settings-row">
                    <Label
                      htmlFor="use-custom-pe-prompt"
                      className="cursor-pointer"
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
                      updateDraft(
                        {
                          prompt_enhancement_prompt: event.target.value,
                        },
                        true
                      )
                    }
                    onBlur={() => void flush()}
                    placeholder={t('general.customPromptPlaceholder')}
                    className={`min-h-32 font-mono text-sm ${
                      draft.prompt_enhancement_prompt == null
                        ? 'cursor-not-allowed opacity-50'
                        : ''
                    }`}
                  />
                  <p className="settings-row__description">
                    {t('general.customPromptHint')}
                  </p>
                </div>
              </>
            ) : null}

            <div className="settings-row">
              <div>
                <Label
                  htmlFor="compact-context-enabled"
                  className="cursor-pointer"
                >
                  {t('general.enableCompactContext')}
                </Label>
                <p className="settings-row__description">
                  {t('general.enableCompactContextHint')}
                </p>
              </div>
              <Switch
                id="compact-context-enabled"
                className="settings-switch"
                checked={draft.compact_context_enabled ?? false}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ compact_context_enabled: checked })
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={History}
          title={t('general.sessionFeaturesTitle')}
        >
          <div className="space-y-4">
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

            <div className="settings-row">
              <div>
                <Label>{t('general.importLocalSessions')}</Label>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setImportOpen(true)}
              >
                {t('general.importLocalSessionsAction')}
              </Button>
            </div>
            <LocalHistoryImportStatus job={importJob} />
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bell}
          title={t('general.notificationsTitle')}
          description={t('general.notificationsDescription')}
        >
          <div className="space-y-3">
            <div className="settings-row">
              <Label htmlFor="sound-enabled" className="cursor-pointer">
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
              <div className="settings-row">
                <Label className="shrink-0">{t('general.sound')}</Label>
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

            <div className="settings-row">
              <Label htmlFor="push-notifications" className="cursor-pointer">
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

            <div className="settings-row">
              <Label className="shrink-0">{t('general.notifyWhen')}</Label>
              <Select
                value={draft.notifications.notify_when ?? 'unfocused'}
                onValueChange={(value: NotificationWhen) =>
                  updateDraft({
                    notifications: {
                      ...draft.notifications,
                      notify_when: value,
                    },
                  })
                }
              >
                <SelectTrigger
                  className="!w-40"
                  aria-label={t('general.notifyWhen')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="unfocused">
                    {t('general.notifyWhenUnfocused')}
                  </SelectItem>
                  <SelectItem value="always">
                    {t('general.notifyWhenAlways')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="settings-row">
              <div>
                <Label
                  htmlFor="crash-reports-enabled"
                  className="cursor-pointer"
                >
                  {t('general.crashReportsToggle')}
                </Label>
                <p className="settings-row__description">
                  {t('general.crashReportsPrivacy')}
                </p>
              </div>
              <Switch
                id="crash-reports-enabled"
                className="settings-switch"
                checked={draft.crash_reports_enabled}
                onCheckedChange={(checked: boolean) =>
                  updateDraft({ crash_reports_enabled: checked })
                }
              />
            </div>
          </div>
        </SettingsSection>
        <PluginSettingsSections />
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-12">
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (basicGuide) basicGuide.restart();
              else writeBasicGuide(restartBasicGuide());
            }}
          >
            {t('general.restartBasicGuide')}
          </Button>
        </div>
      </div>

      <ImportLocalSessionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
