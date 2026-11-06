import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  Check,
  ChevronDown,
  Lightbulb,
  Pencil,
  RefreshCw,
  Terminal,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import {
  SoundFile,
  type AgentManagementView,
  type AgentSessionControlsSnapshot,
  type Config,
  type ExecutorProfileId,
  type NotificationWhen,
} from 'shared/types';

import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { PluginSettingsSections } from '@/components/plugins/PluginSettingsSections';
import { ImportLocalSessionsDialog } from '@/components/sessions/ImportLocalSessionsDialog';
import { LocalHistoryImportStatus } from '@/features/history-import/LocalHistoryImportStatus';
import { useLocalHistoryImportJob } from '@/features/history-import/useLocalHistoryImportJob';
import { resolveEffectiveSessionConfig } from '@/components/settings/AgentSessionConfigPicker';
import { ExternalEditorPicker } from '@/components/settings/ExternalEditorPicker';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { agentManagementApi } from '@/features/agent-management/api';
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
import {
  CustomRoleSessionControls,
  MultiAgentSettings,
  stringRecord,
} from '@/features/collaboration/MultiAgentSettings';
import { setHideBotSessions, useHideBotSessions } from '@/lib/hideBotSessions';
import i18n, { setUiLanguage } from '@/i18n';
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  getUiLanguage,
  type UiLanguage,
} from '@/lib/uiLanguage';
import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';

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
  const portalContainer = usePortalContainer();
  const { config, environment, loading, updateAndSaveConfig } = useUserSystem();
  const basicGuide = useOptionalBasicGuide();
  const localDesktopHost = useLocalDesktopHost();
  const hideBotSessions = useHideBotSessions();
  const [language, setLanguage] = useState<UiLanguage>(() => getUiLanguage());
  const [barAgents, setBarAgents] = useState<AgentManagementView[]>([]);

  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [importOpen, setImportOpen] = useState(false);
  const [multiAgentRangeError, setMultiAgentRangeError] = useState<
    string | null
  >(null);
  const [multiAgentRevision, setMultiAgentRevision] = useState(0);
  const importJob = useLocalHistoryImportJob();
  const reportMultiAgentRange = useCallback((message: string | null) => {
    setMultiAgentRangeError(message);
  }, []);

  const [peDialogOpen, setPeDialogOpen] = useState(false);
  const [peDialogSource, setPeDialogSource] = useState<'toggle' | 'edit'>(
    'edit'
  );
  const [peDialogLeft, setPeDialogLeft] = useState('12.5rem');
  const [peAgentId, setPeAgentId] = useState('');
  const [peModeId, setPeModeId] = useState('');
  const [peConfigValues, setPeConfigValues] = useState<Record<string, string>>(
    {}
  );
  const [peCatalog, setPeCatalog] =
    useState<AgentSessionControlsSnapshot | null>(null);
  const [peCatalogReloadToken, setPeCatalogReloadToken] = useState(0);
  const [peUseCustomPrompt, setPeUseCustomPrompt] = useState(false);
  const [peCustomPrompt, setPeCustomPrompt] = useState(
    DEFAULT_PROMPT_ENHANCEMENT_PROMPT
  );

  useEffect(() => {
    let active = true;
    void agentManagementApi
      .bar()
      .then((rows) => {
        if (!active) return;
        setBarAgents(rows.filter((row) => row.enabled && !row.retired));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const availablePeAgents = useMemo(
    () =>
      barAgents.map((row) => ({
        value: row.agent_id,
        label: row.display_name || getAgentName(row.agent_id) || row.agent_id,
      })),
    [barAgents]
  );

  useEffect(() => {
    if (!peDialogOpen) return;
    if (!peAgentId && availablePeAgents.length > 0) {
      setPeAgentId(availablePeAgents[0].value);
    }
  }, [availablePeAgents, peAgentId, peDialogOpen]);

  useEffect(() => {
    if (!peDialogOpen) return;
    const settingsShell = document.querySelector('.settings-page');
    settingsShell?.classList.add('collaboration-settings-window-blurred');

    const syncOverlayLeft = () => {
      const settingsContent = document.querySelector<HTMLElement>(
        '[data-settings-content]'
      );
      const settingsSidebar =
        document.querySelector<HTMLElement>('.settings-sidebar');
      const contentLeft = settingsContent?.getBoundingClientRect().left ?? 0;
      const sidebarRight = settingsSidebar?.getBoundingClientRect().right ?? 0;
      const measuredLeft = contentLeft > 0 ? contentLeft : sidebarRight;
      if (measuredLeft > 0) {
        setPeDialogLeft(`${Math.round(measuredLeft)}px`);
        return;
      }
      setPeDialogLeft(
        settingsSidebar?.classList.contains('settings-sidebar--flush')
          ? '11rem'
          : '12.5rem'
      );
    };

    syncOverlayLeft();
    window.addEventListener('resize', syncOverlayLeft);
    return () => {
      window.removeEventListener('resize', syncOverlayLeft);
      settingsShell?.classList.remove('collaboration-settings-window-blurred');
    };
  }, [peDialogOpen]);

  const { writeNow, writeSettled, holding } = useLiveSettingsCommit(
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

  const populatePeFormFromDraft = useCallback(
    (currentDraft: Config) => {
      const initialAgentId =
        currentDraft.prompt_enhancement_agent_id?.trim() ||
        availablePeAgents[0]?.value ||
        '';
      setPeAgentId(initialAgentId);
      setPeModeId(currentDraft.prompt_enhancement_mode ?? '');
      setPeConfigValues(
        stringRecord(currentDraft.prompt_enhancement_session_config)
      );
      const hasCustom = currentDraft.prompt_enhancement_prompt != null;
      setPeUseCustomPrompt(hasCustom);
      setPeCustomPrompt(
        currentDraft.prompt_enhancement_prompt ??
          DEFAULT_PROMPT_ENHANCEMENT_PROMPT
      );
    },
    [availablePeAgents]
  );

  const handlePromptEnhancementToggle = (checked: boolean) => {
    if (!draft) return;
    if (!checked) {
      setPeDialogOpen(false);
      updateDraft({ prompt_enhancement_enabled: false });
      return;
    }
    populatePeFormFromDraft(draft);
    setPeDialogSource('toggle');
    setPeDialogOpen(true);
  };

  const openEditPromptEnhancementDialog = () => {
    if (!draft) return;
    populatePeFormFromDraft(draft);
    setPeDialogSource('edit');
    setPeDialogOpen(true);
  };

  const handleCancelPromptEnhancementDialog = () => {
    setPeDialogOpen(false);
    if (peDialogSource === 'toggle' && draft?.prompt_enhancement_enabled) {
      updateDraft({ prompt_enhancement_enabled: false });
    }
  };

  const handleRefreshPeSessionControls = () => {
    if (!peAgentId.trim()) return;
    setPeCatalogReloadToken((prev) => prev + 1);
  };

  const handleSavePromptEnhancementDialog = () => {
    const effective = resolveEffectiveSessionConfig(
      peCatalog,
      peModeId.trim() || null,
      peConfigValues
    );
    updateDraft({
      prompt_enhancement_enabled: true,
      prompt_enhancement_agent_id: peAgentId.trim(),
      prompt_enhancement_mode: effective.modeId?.trim() || null,
      prompt_enhancement_session_config: stringRecord(effective.configValues),
      prompt_enhancement_prompt: peUseCustomPrompt ? peCustomPrompt : null,
    });
    setPeDialogOpen(false);
    toast.success(t('general.settingsSaved'));
  };

  const playSound = async (soundFile: SoundFile) => {
    try {
      await configApi.playNotificationSound(soundFile);
    } catch (error) {
      console.error('Failed to play notification sound:', error);
    }
  };

  void multiAgentRangeError;
  void setMultiAgentRevision;

  if (loading) {
    return <SurfaceLoading />;
  }

  if (!draft) {
    return null;
  }

  const hostPlatform = terminalHostPlatform(environment?.os_type);
  const terminalShellOptions = getTerminalShellOptions(hostPlatform);

  const activePeAgentId =
    draft.prompt_enhancement_agent_id?.trim() ||
    availablePeAgents[0]?.value ||
    '';
  const activePeAgentLabel =
    availablePeAgents.find((item) => item.value === activePeAgentId)?.label ||
    getAgentName(activePeAgentId) ||
    activePeAgentId ||
    t('general.selectAgentPlaceholder');
  const peSessionParts = [
    draft.prompt_enhancement_mode?.trim() || '',
    ...Object.values(stringRecord(draft.prompt_enhancement_session_config)),
  ].filter(Boolean);
  const peSessionSummary =
    peSessionParts.length > 0
      ? peSessionParts.join(' · ')
      : i18n.t('panels:ui.multiAgent.defaultSessionSettings');
  const selectedPeModalAgentLabel =
    availablePeAgents.find((item) => item.value === peAgentId)?.label ||
    getAgentName(peAgentId) ||
    peAgentId;

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

            <div className="settings-row">
              <div>
                <Label>{t('appearance.language.label')}</Label>
                <p className="settings-row__description">
                  {t('appearance.language.hint')}
                </p>
              </div>
              <Select
                value={language}
                onValueChange={(value) => {
                  const next = value as UiLanguage;
                  setLanguage(next);
                  setUiLanguage(next);
                }}
              >
                <SelectTrigger
                  className="!w-40"
                  aria-label={t('appearance.language.label')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {SUPPORTED_LANGUAGES.map((lng) => (
                    <SelectItem key={lng} value={lng}>
                      {LANGUAGE_LABELS[lng]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection icon={Users} title={t('general.multiAgentTitle')}>
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label htmlFor="multi-agent-enabled" className="cursor-pointer">
                  {t('general.multiAgentEnabled')}
                </Label>
                <p className="settings-row__description">
                  {t('general.multiAgentEnabledHint')}
                </p>
              </div>
              <Switch
                id="multi-agent-enabled"
                className="settings-switch"
                checked={Boolean(draft.multi_agent_enabled)}
                onCheckedChange={(checked: boolean) => {
                  const previous = draft.multi_agent_enabled;
                  setDraft((current) =>
                    current
                      ? { ...current, multi_agent_enabled: checked }
                      : current
                  );
                  if (!checked) setMultiAgentRangeError(null);
                  void updateAndSaveConfig({
                    multi_agent_enabled: checked,
                  }).then((saved) => {
                    if (saved) return;
                    setDraft((current) =>
                      current
                        ? { ...current, multi_agent_enabled: previous }
                        : current
                    );
                    toast.error(t('general.saveFailed'));
                  });
                }}
              />
            </div>
            <div className="settings-row">
              <div>
                <Label
                  htmlFor="multi-agent-hide-bot-sessions"
                  className="cursor-pointer"
                >
                  {t('general.multiAgentHideBotSessions')}
                </Label>
                <p className="settings-row__description">
                  {t('general.multiAgentHideBotSessionsHint')}
                </p>
              </div>
              <Switch
                id="multi-agent-hide-bot-sessions"
                className="settings-switch"
                checked={hideBotSessions}
                onCheckedChange={(checked: boolean) => {
                  setHideBotSessions(checked);
                }}
              />
            </div>
            {draft.multi_agent_enabled ? (
              <MultiAgentSettings
                draft={draft}
                hostReady={Boolean(config?.multi_agent_enabled)}
                revision={multiAgentRevision}
                updateDraft={updateDraft}
                onRangeError={reportMultiAgentRange}
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
                checked={
                  Boolean(draft.prompt_enhancement_enabled) ||
                  (peDialogOpen && peDialogSource === 'toggle')
                }
                onCheckedChange={handlePromptEnhancementToggle}
              />
            </div>

            {draft.prompt_enhancement_enabled ? (
              <div
                className="min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
                data-testid="prompt-enhancement-list-container"
              >
                <div className="divide-y divide-border/60">
                  <div
                    data-testid="prompt-enhancement-config-row"
                    className="flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      {activePeAgentId ? (
                        <AgentIcon
                          agent={
                            activePeAgentId as ExecutorProfileId['executor']
                          }
                          className="h-4 w-4 shrink-0"
                        />
                      ) : null}
                      <span className="max-w-[12rem] shrink-0 truncate text-xs font-medium text-foreground">
                        {activePeAgentLabel}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {peSessionSummary}
                      </span>
                      <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {draft.prompt_enhancement_prompt != null
                          ? t('general.customPromptEnabledStatus')
                          : t('general.customPromptDisabledStatus')}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        data-testid="prompt-enhancement-edit-btn"
                        aria-label={t('general.editPromptEnhancement')}
                        onClick={openEditPromptEnhancementDialog}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
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
                  updateDraft({
                    previous_session_continuation_enabled: checked,
                  })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <Label>{t('general.importLocalSessions')}</Label>
                <p className="settings-row__description">
                  {t('general.importLocalSessionsDescription')}
                </p>
              </div>
              <Button
                type="button"
                variant="default"
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
              <div>
                <Label htmlFor="sound-enabled" className="cursor-pointer">
                  {t('general.soundNotification')}
                </Label>
                <p className="settings-row__description">
                  {t('general.soundNotificationDescription')}
                </p>
              </div>
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
              <div>
                <Label htmlFor="push-notifications" className="cursor-pointer">
                  {t('general.pushNotification')}
                </Label>
                <p className="settings-row__description">
                  {t('general.pushNotificationDescription')}
                </p>
              </div>
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

      {peDialogOpen
        ? createPortal(
            <div
              data-testid="prompt-enhancement-modal-overlay"
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-y-0 right-0 z-[9999] flex items-center justify-center p-6"
              style={{
                left: peDialogLeft,
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
              }}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  handleCancelPromptEnhancementDialog();
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t('general.promptEnhancementTitle')}
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[440px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {t('general.promptEnhancementTitle')}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label={i18n.t('panels:tabCreation.close', '关闭')}
                    onClick={handleCancelPromptEnhancementDialog}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>

                <form
                  className="flex flex-col gap-3.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSavePromptEnhancementDialog();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label>{t('general.promptEnhancementAgentLabel')}</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-label={t('general.promptEnhancementAgentLabel')}
                          data-value={peAgentId}
                          className="custom-role-agent-trigger raised-control h-8 w-full justify-between px-2.5 text-[13px] font-normal"
                        >
                          <span className="flex min-w-0 items-center gap-2 truncate">
                            {peAgentId ? (
                              <AgentIcon
                                agent={
                                  peAgentId as ExecutorProfileId['executor']
                                }
                                className="h-3.5 w-3.5 shrink-0"
                              />
                            ) : null}
                            <span className="truncate">
                              {selectedPeModalAgentLabel ||
                                t('general.selectAgentPlaceholder')}
                            </span>
                          </span>
                          <ChevronDown
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
                      >
                        {availablePeAgents.map((agent) => {
                          const isSelected = peAgentId === agent.value;
                          return (
                            <DropdownMenuItem
                              key={agent.value}
                              data-state={isSelected ? 'checked' : undefined}
                              onSelect={() => {
                                setPeAgentId(agent.value);
                                setPeModeId('');
                                setPeConfigValues({});
                              }}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                                <AgentIcon
                                  agent={
                                    agent.value as ExecutorProfileId['executor']
                                  }
                                  className="h-3.5 w-3.5 shrink-0"
                                />
                                <span className="truncate">{agent.label}</span>
                              </span>
                              {isSelected ? (
                                <Check
                                  className="h-3.5 w-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                              ) : null}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div
                    className="space-y-1.5"
                    data-testid="prompt-enhancement-session-config"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Label>
                        {t('general.promptEnhancementSessionConfig')}
                      </Label>
                      {peAgentId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t('general.refreshSessionControls')}
                          onClick={() => void handleRefreshPeSessionControls()}
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                    <CustomRoleSessionControls
                      agentId={peAgentId}
                      modeId={peModeId}
                      values={peConfigValues}
                      onModeId={setPeModeId}
                      onValues={setPeConfigValues}
                      onCatalogChange={setPeCatalog}
                      reloadToken={peCatalogReloadToken}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="settings-row flex min-h-7 items-center justify-between gap-3">
                      <Label
                        htmlFor="use-custom-pe-prompt"
                        className="cursor-pointer leading-none"
                      >
                        {t('general.customOptimizationPrompt')}
                      </Label>
                      <Switch
                        id="use-custom-pe-prompt"
                        className="settings-switch shrink-0"
                        checked={peUseCustomPrompt}
                        onCheckedChange={(checked: boolean) => {
                          setPeUseCustomPrompt(checked);
                          if (checked && !peCustomPrompt.trim()) {
                            setPeCustomPrompt(
                              DEFAULT_PROMPT_ENHANCEMENT_PROMPT
                            );
                          }
                        }}
                      />
                    </div>
                    {peUseCustomPrompt ? (
                      <Textarea
                        aria-label={t('general.customOptimizationPrompt')}
                        value={peCustomPrompt}
                        onChange={(event) =>
                          setPeCustomPrompt(event.target.value)
                        }
                        placeholder={t('general.customPromptPlaceholder')}
                        className="min-h-28 font-mono text-xs"
                      />
                    ) : null}
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="prompt-enhancement-cancel-btn"
                      onClick={handleCancelPromptEnhancementDialog}
                    >
                      {i18n.t('panels:ui.multiAgent.cancel')}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      data-dialog-primary="true"
                      data-testid="prompt-enhancement-save-btn"
                    >
                      {i18n.t('panels:ui.multiAgent.save')}
                    </Button>
                  </div>
                </form>
              </div>
            </div>,
            portalContainer ?? document.body
          )
        : null}

      <ImportLocalSessionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
