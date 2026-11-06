import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  GitPullRequest,
  Github,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  RefreshCw,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import {
  DEFAULT_PR_DESCRIPTION_PROMPT,
  type AgentManagementView,
  type AgentSessionControlsSnapshot,
  type Config,
  type ExecutorProfileId,
} from 'shared/types';

import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { resolveEffectiveSessionConfig } from '@/components/settings/AgentSessionConfigPicker';
import { useUserSystem } from '@/components/ConfigProvider';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { agentManagementApi } from '@/features/agent-management/api';
import {
  CustomRoleSessionControls,
  stringRecord,
} from '@/features/collaboration/MultiAgentSettings';
import i18n from '@/i18n';
import {
  type GitHubCliStatus,
  type GitVersionStatus,
  type VersionControlCliSettings,
  versionControlApi,
} from '@/lib/api';
import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';

function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.trim()
  ) {
    return (error as { message: string }).message;
  }
  return null;
}

function StatusLine({
  ok,
  loading,
  children,
}: {
  ok: boolean;
  loading?: boolean;
  children: ReactNode;
}) {
  const Icon = loading ? Loader2 : ok ? CheckCircle2 : AlertCircle;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Icon
        className={`h-4 w-4 shrink-0 ${
          loading
            ? 'animate-spin text-muted-foreground'
            : ok
              ? 'text-success'
              : 'text-warning'
        }`}
      />
      <span className="truncate text-muted-foreground">{children}</span>
    </div>
  );
}

export function VersionControlSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const portalContainer = usePortalContainer();
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [cliSettings, setCliSettings] =
    useState<VersionControlCliSettings | null>(null);
  const [customGitPath, setCustomGitPath] = useState('');
  const [gitStatus, setGitStatus] = useState<GitVersionStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubCliStatus | null>(
    null
  );
  const [githubHost, setGithubHost] = useState('github.com');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitSaving, setGitSaving] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubInstalling, setGithubInstalling] = useState(false);

  const [barAgents, setBarAgents] = useState<AgentManagementView[]>([]);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prDialogSource, setPrDialogSource] = useState<'toggle' | 'edit'>(
    'edit'
  );
  const [prDialogLeft, setPrDialogLeft] = useState('12.5rem');
  const [prAgentId, setPrAgentId] = useState('');
  const [prModeId, setPrModeId] = useState('');
  const [prConfigValues, setPrConfigValues] = useState<Record<string, string>>(
    {}
  );
  const [prCatalog, setPrCatalog] =
    useState<AgentSessionControlsSnapshot | null>(null);
  const [prCatalogReloadToken, setPrCatalogReloadToken] = useState(0);
  const [prUseCustomPrompt, setPrUseCustomPrompt] = useState(false);
  const [prCustomPrompt, setPrCustomPrompt] = useState(
    DEFAULT_PR_DESCRIPTION_PROMPT
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

  const availablePrAgents = useMemo(
    () =>
      barAgents.map((row) => ({
        value: row.agent_id,
        label: row.display_name || getAgentName(row.agent_id) || row.agent_id,
      })),
    [barAgents]
  );

  useEffect(() => {
    if (!prDialogOpen) return;
    if (!prAgentId && availablePrAgents.length > 0) {
      setPrAgentId(availablePrAgents[0].value);
    }
  }, [availablePrAgents, prAgentId, prDialogOpen]);

  useEffect(() => {
    if (!prDialogOpen) return;
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
        setPrDialogLeft(`${Math.round(measuredLeft)}px`);
        return;
      }
      setPrDialogLeft(
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
  }, [prDialogOpen]);

  const { writeNow, writeSettled, flush, holding } = useLiveSettingsCommit(
    async (next: Config) => {
      const saved = await updateAndSaveConfig({
        commit_reminder_enabled: next.commit_reminder_enabled,
        commit_reminder_mode: next.commit_reminder_mode,
        commit_reminder_line_threshold: next.commit_reminder_line_threshold,
        pr_auto_description_enabled: next.pr_auto_description_enabled,
        pr_auto_description_prompt: next.pr_auto_description_prompt,
        pr_auto_description_agent_id: next.pr_auto_description_agent_id,
        pr_auto_description_mode: next.pr_auto_description_mode,
        pr_auto_description_session_config:
          next.pr_auto_description_session_config,
      });
      if (!saved) {
        toast.error(t('versionControl.saveFailed'), {
          description: t('versionControl.saveFailedDesc'),
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

  const populatePrFormFromDraft = useCallback(
    (currentDraft: Config) => {
      const initialAgentId =
        currentDraft.pr_auto_description_agent_id?.trim() ||
        availablePrAgents[0]?.value ||
        '';
      setPrAgentId(initialAgentId);
      setPrModeId(currentDraft.pr_auto_description_mode ?? '');
      setPrConfigValues(
        stringRecord(currentDraft.pr_auto_description_session_config)
      );
      const hasCustom = currentDraft.pr_auto_description_prompt != null;
      setPrUseCustomPrompt(hasCustom);
      setPrCustomPrompt(
        currentDraft.pr_auto_description_prompt ?? DEFAULT_PR_DESCRIPTION_PROMPT
      );
    },
    [availablePrAgents]
  );

  const handlePrAutoDescriptionToggle = (checked: boolean) => {
    if (!draft) return;
    if (!checked) {
      setPrDialogOpen(false);
      updateDraft({ pr_auto_description_enabled: false });
      return;
    }
    populatePrFormFromDraft(draft);
    setPrDialogSource('toggle');
    setPrDialogOpen(true);
  };

  const openEditPrDescriptionDialog = () => {
    if (!draft) return;
    populatePrFormFromDraft(draft);
    setPrDialogSource('edit');
    setPrDialogOpen(true);
  };

  const handleCancelPrDescriptionDialog = () => {
    setPrDialogOpen(false);
    if (prDialogSource === 'toggle' && draft?.pr_auto_description_enabled) {
      updateDraft({ pr_auto_description_enabled: false });
    }
  };

  const handleRefreshPrSessionControls = () => {
    if (!prAgentId.trim()) return;
    setPrCatalogReloadToken((prev) => prev + 1);
  };

  const handleSavePrDescriptionDialog = () => {
    const effective = resolveEffectiveSessionConfig(
      prCatalog,
      prModeId.trim() || null,
      prConfigValues
    );
    updateDraft({
      pr_auto_description_enabled: true,
      pr_auto_description_agent_id: prAgentId.trim(),
      pr_auto_description_mode: effective.modeId?.trim() || null,
      pr_auto_description_session_config: stringRecord(effective.configValues),
      pr_auto_description_prompt: prUseCustomPrompt ? prCustomPrompt : null,
    });
    setPrDialogOpen(false);
    toast.success(t('versionControl.settingsSaved'));
  };

  const refreshGit = useCallback(async () => {
    try {
      setGitLoading(true);
      setGitStatus(await versionControlApi.detectGit());
    } catch (error) {
      toast.error(t('versionControl.gitDetectFailed'), {
        description:
          extractErrorMessage(error) ?? t('versionControl.gitDetectFailedDesc'),
      });
    } finally {
      setGitLoading(false);
    }
  }, [t]);

  const refreshGithub = useCallback(async () => {
    try {
      setGithubLoading(true);
      const status = await versionControlApi.getGithubCliStatus(githubHost);
      setGithubStatus(status);
      setGithubHost(status.host);
    } catch (error) {
      toast.error(t('versionControl.githubStatusFailed'), {
        description:
          extractErrorMessage(error) ??
          t('versionControl.githubStatusFailedDesc'),
      });
    } finally {
      setGithubLoading(false);
    }
  }, [githubHost, t]);

  useEffect(() => {
    let cancelled = false;

    const loadCliSettings = async () => {
      try {
        const settings = await versionControlApi.getSettings();
        if (cancelled) return;
        setCliSettings(settings);
        setCustomGitPath(settings.git_custom_path ?? '');
      } catch (error) {
        toast.error(t('versionControl.settingsLoadFailed'), {
          description:
            extractErrorMessage(error) ??
            t('versionControl.settingsLoadFailedDesc'),
        });
      }
    };

    const loadGithubStatus = async () => {
      try {
        setGithubLoading(true);
        const status = await versionControlApi.getGithubCliStatus('github.com');
        if (cancelled) return;
        setGithubStatus(status);
        setGithubHost(status.host);
      } catch (error) {
        toast.error(t('versionControl.githubStatusFailed'), {
          description:
            extractErrorMessage(error) ??
            t('versionControl.githubStatusFailedDesc'),
        });
      } finally {
        if (!cancelled) {
          setGithubLoading(false);
        }
      }
    };

    void loadCliSettings();
    void refreshGit();
    void loadGithubStatus();

    return () => {
      cancelled = true;
    };
  }, [refreshGit, t]);

  useEffect(() => {
    const refreshSettingsOnFocus = () => {
      if (
        cliSettings &&
        customGitPath !== (cliSettings.git_custom_path ?? '')
      ) {
        return;
      }
      void versionControlApi
        .getSettings()
        .then((settings) => {
          setCliSettings(settings);
          setCustomGitPath(settings.git_custom_path ?? '');
        })
        .catch((error) => {
          toast.error(t('versionControl.settingsLoadFailed'), {
            description:
              extractErrorMessage(error) ??
              t('versionControl.settingsLoadFailedDesc'),
          });
        });
    };
    window.addEventListener('focus', refreshSettingsOnFocus);
    window.addEventListener(SETTINGS_CHANGED_EVENT, refreshSettingsOnFocus);
    return () => {
      window.removeEventListener('focus', refreshSettingsOnFocus);
      window.removeEventListener(
        SETTINGS_CHANGED_EVENT,
        refreshSettingsOnFocus
      );
    };
  }, [cliSettings, customGitPath, t]);

  const handleTestGitPath = async () => {
    const trimmed = customGitPath.trim();
    if (!trimmed) {
      await refreshGit();
      return;
    }

    try {
      setGitLoading(true);
      const status = await versionControlApi.testGitPath(trimmed);
      setGitStatus(status);
      if (status.installed) {
        toast.success(t('versionControl.gitPathAvailable'), {
          description: status.version ?? status.path ?? undefined,
        });
      } else {
        toast.warning(t('versionControl.gitPathUnavailable'), {
          description:
            status.message ?? t('versionControl.gitPathUnavailableDesc'),
        });
      }
    } catch (error) {
      toast.error(t('versionControl.gitPathTestFailed'), {
        description:
          extractErrorMessage(error) ??
          t('versionControl.gitPathTestFailedDesc'),
      });
    } finally {
      setGitLoading(false);
    }
  };

  const handleSaveGitPath = async (path: string | null) => {
    try {
      setGitSaving(true);
      const next = await versionControlApi.updateSettings({
        git_custom_path: path,
      });
      setCliSettings(next);
      setCustomGitPath(next.git_custom_path ?? '');
      await refreshGit();
      toast.success(t('versionControl.gitSettingsSaved'));
    } catch (error) {
      toast.error(t('versionControl.gitSettingsSaveFailed'), {
        description:
          extractErrorMessage(error) ??
          t('versionControl.gitSettingsSaveFailedDesc'),
      });
    } finally {
      setGitSaving(false);
    }
  };

  const handleOpenGithubLogin = async () => {
    try {
      await versionControlApi.openGithubCliLogin(githubHost);
      toast.info(t('versionControl.githubLoginTerminalOpened'));
    } catch (error) {
      const message =
        extractErrorMessage(error) ??
        t('versionControl.githubLoginStartFailed');
      toast.error(t('versionControl.githubLoginTerminalFailed'), {
        description: /interactive Host terminal/i.test(message)
          ? t('versionControl.githubLoginNeedsHostTerminal')
          : message,
      });
    }
  };

  const handleInstallGithubCli = async () => {
    try {
      setGithubInstalling(true);
      const status = await versionControlApi.installGithubCli(githubHost);
      setGithubStatus(status);
      setGithubHost(status.host);
      if (!status.gh_installed) {
        toast.error(t('versionControl.githubCliInstallFailed'), {
          description:
            status.message ?? t('versionControl.githubCliInstallFailedDesc'),
        });
        return;
      }
      toast.success(t('versionControl.githubCliInstalled'), {
        description: status.gh_path ?? undefined,
      });
    } catch (error) {
      toast.error(t('versionControl.githubCliInstallFailed'), {
        description:
          extractErrorMessage(error) ??
          t('versionControl.githubCliInstallFailedDesc'),
      });
    } finally {
      setGithubInstalling(false);
    }
  };

  const handleGithubLogout = async () => {
    try {
      setGithubLoading(true);
      const status = await versionControlApi.logoutGithubCli(
        githubStatus?.host ?? githubHost,
        githubStatus?.username
      );
      setGithubStatus(status);
      toast.success(t('versionControl.githubLoggedOut'));
    } catch (error) {
      toast.error(t('versionControl.githubLogoutFailed'), {
        description:
          extractErrorMessage(error) ??
          t('versionControl.githubLogoutFailedDesc'),
      });
    } finally {
      setGithubLoading(false);
    }
  };

  if (loading) {
    return <SurfaceLoading />;
  }

  if (!draft) {
    return null;
  }

  const activePrAgentId =
    draft.pr_auto_description_agent_id?.trim() ||
    availablePrAgents[0]?.value ||
    '';
  const activePrAgentLabel =
    availablePrAgents.find((item) => item.value === activePrAgentId)?.label ||
    getAgentName(activePrAgentId) ||
    activePrAgentId ||
    t('general.selectAgentPlaceholder');
  const prSessionParts = [
    draft.pr_auto_description_mode?.trim() || '',
    ...Object.values(stringRecord(draft.pr_auto_description_session_config)),
  ].filter(Boolean);
  const prSessionSummary =
    prSessionParts.length > 0
      ? prSessionParts.join(' · ')
      : i18n.t('panels:ui.multiAgent.defaultSessionSettings');
  const selectedPrModalAgentLabel =
    availablePrAgents.find((item) => item.value === prAgentId)?.label ||
    getAgentName(prAgentId) ||
    prAgentId;

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={TerminalSquare}
          title={t('versionControl.gitVersionSectionTitle')}
          description={t('versionControl.gitVersionSectionDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('versionControl.currentGitLabel')}</Label>
                <p className="settings-row__description">
                  {gitStatus?.path ?? t('versionControl.currentGitFallback')}
                </p>
              </div>
              <StatusLine
                ok={Boolean(gitStatus?.installed)}
                loading={gitLoading}
              >
                {gitStatus?.installed
                  ? (gitStatus.version ?? t('versionControl.gitAvailable'))
                  : (gitStatus?.message ?? t('versionControl.gitNotDetected'))}
              </StatusLine>
            </div>

            <div className="space-y-2">
              <div className="settings-row">
                <div>
                  <Label>{t('versionControl.customGitPathLabel')}</Label>
                  <p className="settings-row__description">
                    {t('versionControl.customGitPathDescription')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <TextInput
                    label={t('versionControl.customGitPathLabel')}
                    isLabelHidden
                    value={customGitPath}
                    onChange={setCustomGitPath}
                    placeholder={t('versionControl.customGitPathPlaceholder')}
                    width="220px"
                    className="w-[220px] [&_input]:text-sm"
                  />
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleTestGitPath}
                    disabled={gitLoading}
                  >
                    {gitLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {t('versionControl.detect')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() =>
                      handleSaveGitPath(customGitPath.trim() || null)
                    }
                    disabled={gitSaving}
                  >
                    {gitSaving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('common:save')}
                  </Button>
                </div>
              </div>
              {cliSettings?.git_custom_path ? (
                <Button
                  className="w-fit"
                  variant="ghost"
                  type="button"
                  onClick={() => handleSaveGitPath(null)}
                  disabled={gitSaving}
                >
                  {t('versionControl.useSystemGit')}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Bell}
          title={t('versionControl.commitReminderSectionTitle')}
          description={t('versionControl.commitReminderSectionDescription')}
        >
          <div className="settings-row">
            <div>
              <Label id="commit-reminder-enabled-label">
                {t('versionControl.enableCommitReminderLabel')}
              </Label>
              <p className="settings-row__description">
                {t('versionControl.enableCommitReminderDescription')}
              </p>
            </div>
            <Switch
              aria-label={t('versionControl.enableCommitReminderLabel')}
              checked={draft.commit_reminder_enabled ?? true}
              onCheckedChange={(checked) =>
                updateDraft({ commit_reminder_enabled: checked })
              }
            />
          </div>
          <fieldset
            className="settings-subrows"
            aria-labelledby="commit-reminder-enabled-label"
            disabled={!draft.commit_reminder_enabled}
          >
            <div className="settings-row">
              <div className="settings-row__copy">
                <Label htmlFor="commit-reminder-mode">
                  {t('versionControl.commitReminderModeLabel')}
                </Label>
                <p className="settings-row__description">
                  {t('versionControl.commitReminderModeDescription')}
                </p>
              </div>
              <AstryxSelect
                id="commit-reminder-mode"
                ariaLabel={t('versionControl.commitReminderModeLabel')}
                value={draft.commit_reminder_mode ?? 'smart'}
                className="!w-36 shrink-0"
                options={[
                  {
                    value: 'separate_turn',
                    label: t('versionControl.commitReminderModeSeparate'),
                  },
                  {
                    value: 'smart',
                    label: t('versionControl.commitReminderModeSmart'),
                  },
                ]}
                onChange={(value) =>
                  updateDraft({
                    commit_reminder_mode: value as 'separate_turn' | 'smart',
                  })
                }
                disabled={!draft.commit_reminder_enabled}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row__copy">
                <Label htmlFor="commit-reminder-threshold">
                  {t('versionControl.commitReminderThresholdLabel')}
                </Label>
                <p className="settings-row__description">
                  {t('versionControl.commitReminderThresholdDescription')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="commit-reminder-threshold"
                  aria-label={t('versionControl.commitReminderThresholdLabel')}
                  className="w-28 text-right tabular-nums"
                  type="number"
                  min={0}
                  step={100}
                  value={draft.commit_reminder_line_threshold ?? 10000}
                  onChange={(event) =>
                    updateDraft(
                      {
                        commit_reminder_line_threshold: Math.max(
                          0,
                          Math.min(
                            4_294_967_295,
                            Number.parseInt(event.target.value || '0', 10)
                          )
                        ),
                      },
                      true
                    )
                  }
                  onBlur={() => void flush()}
                />
                <span className="text-xs text-muted-foreground">
                  {t('versionControl.linesUnit')}
                </span>
              </div>
            </div>
          </fieldset>
        </SettingsSection>

        <SettingsSection
          icon={GitPullRequest}
          title={t('versionControl.prSectionTitle')}
          description={t('versionControl.prSectionDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label
                  htmlFor="pr-auto-description-enabled"
                  className="cursor-pointer"
                >
                  {t('versionControl.autoPrDescriptionLabel')}
                </Label>
                <p className="settings-row__description">
                  {t('versionControl.autoPrDescriptionDescription')}
                </p>
              </div>
              <Switch
                id="pr-auto-description-enabled"
                aria-label={t('versionControl.autoPrDescriptionLabel')}
                className="settings-switch"
                checked={
                  Boolean(draft.pr_auto_description_enabled) ||
                  (prDialogOpen && prDialogSource === 'toggle')
                }
                onCheckedChange={handlePrAutoDescriptionToggle}
              />
            </div>

            {draft.pr_auto_description_enabled ? (
              <div
                className="min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
                data-testid="pr-description-list-container"
              >
                <div className="divide-y divide-border/60">
                  <div
                    data-testid="pr-description-config-row"
                    className="flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      {activePrAgentId ? (
                        <AgentIcon
                          agent={
                            activePrAgentId as ExecutorProfileId['executor']
                          }
                          className="h-4 w-4 shrink-0"
                        />
                      ) : null}
                      <span className="max-w-[12rem] shrink-0 truncate text-xs font-medium text-foreground">
                        {activePrAgentLabel}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {prSessionSummary}
                      </span>
                      <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {draft.pr_auto_description_prompt != null
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
                        data-testid="pr-description-edit-btn"
                        aria-label={t('versionControl.editPrDescription')}
                        onClick={openEditPrDescriptionDialog}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Github}
          title={t('versionControl.githubAccountSectionTitle')}
          description={t('versionControl.githubAccountSectionDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('versionControl.loginStatusLabel')}</Label>
                <p className="settings-row__description">
                  {githubStatus?.gh_path ??
                    t('versionControl.loginStatusFallback')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <StatusLine
                  ok={Boolean(githubStatus?.authenticated)}
                  loading={githubLoading}
                >
                  {githubStatus?.authenticated
                    ? (githubStatus.username ?? t('versionControl.loggedIn'))
                    : githubStatus?.gh_installed
                      ? t('versionControl.notLoggedIn')
                      : t('versionControl.ghNotInstalled')}
                </StatusLine>
                {!githubLoading && githubStatus?.gh_installed === false && (
                  <Button
                    type="button"
                    onClick={handleInstallGithubCli}
                    disabled={githubInstalling}
                  >
                    {githubInstalling ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {githubInstalling
                      ? t('versionControl.installingGithubCli')
                      : t('versionControl.installGithubCli')}
                  </Button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div>
                <Label>GitHub Host</Label>
                <p className="settings-row__description">
                  {t('versionControl.githubHostDescription')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <TextInput
                  label="GitHub Host"
                  isLabelHidden
                  value={githubHost}
                  onChange={setGithubHost}
                  placeholder="github.com"
                  isDisabled={githubInstalling}
                  width="180px"
                  className="w-[180px] [&_input]:text-sm"
                />
                <Button
                  variant="outline"
                  type="button"
                  onClick={refreshGithub}
                  disabled={githubLoading || githubInstalling}
                >
                  {githubLoading ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {t('versionControl.refresh')}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={handleOpenGithubLogin}
                  disabled={
                    githubLoading ||
                    githubInstalling ||
                    !githubStatus?.gh_installed
                  }
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {t('versionControl.login')}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  onClick={handleGithubLogout}
                  disabled={
                    githubLoading ||
                    githubInstalling ||
                    !githubStatus?.authenticated
                  }
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  {t('versionControl.logout')}
                </Button>
              </div>
            </div>
          </div>
        </SettingsSection>
      </div>

      {prDialogOpen
        ? createPortal(
            <div
              data-testid="pr-description-modal-overlay"
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-y-0 right-0 z-[9999] flex items-center justify-center p-6"
              style={{
                left: prDialogLeft,
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
              }}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  handleCancelPrDescriptionDialog();
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t('versionControl.prSectionTitle')}
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[440px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {t('versionControl.prSectionTitle')}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label={i18n.t('panels:tabCreation.close', '关闭')}
                    onClick={handleCancelPrDescriptionDialog}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>

                <form
                  className="flex flex-col gap-3.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSavePrDescriptionDialog();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label>{t('versionControl.prDescriptionAgentLabel')}</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-label={t(
                            'versionControl.prDescriptionAgentLabel'
                          )}
                          data-value={prAgentId}
                          className="custom-role-agent-trigger raised-control h-8 w-full justify-between px-2.5 text-[13px] font-normal"
                        >
                          <span className="flex min-w-0 items-center gap-2 truncate">
                            {prAgentId ? (
                              <AgentIcon
                                agent={
                                  prAgentId as ExecutorProfileId['executor']
                                }
                                className="h-3.5 w-3.5 shrink-0"
                              />
                            ) : null}
                            <span className="truncate">
                              {selectedPrModalAgentLabel ||
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
                        {availablePrAgents.map((agent) => {
                          const isSelected = prAgentId === agent.value;
                          return (
                            <DropdownMenuItem
                              key={agent.value}
                              data-state={isSelected ? 'checked' : undefined}
                              onSelect={() => {
                                setPrAgentId(agent.value);
                                setPrModeId('');
                                setPrConfigValues({});
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
                    data-testid="pr-description-session-config"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Label>
                        {t('versionControl.prDescriptionSessionConfig')}
                      </Label>
                      {prAgentId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t('general.refreshSessionControls')}
                          onClick={() => void handleRefreshPrSessionControls()}
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                    <CustomRoleSessionControls
                      agentId={prAgentId}
                      modeId={prModeId}
                      values={prConfigValues}
                      onModeId={setPrModeId}
                      onValues={setPrConfigValues}
                      onCatalogChange={setPrCatalog}
                      reloadToken={prCatalogReloadToken}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="settings-row flex min-h-7 items-center justify-between gap-3">
                      <Label
                        htmlFor="use-custom-pr-prompt"
                        className="cursor-pointer leading-none"
                      >
                        {t('versionControl.customPrPromptLabel')}
                      </Label>
                      <Switch
                        id="use-custom-pr-prompt"
                        className="settings-switch shrink-0"
                        checked={prUseCustomPrompt}
                        onCheckedChange={(checked: boolean) => {
                          setPrUseCustomPrompt(checked);
                          if (checked && !prCustomPrompt.trim()) {
                            setPrCustomPrompt(DEFAULT_PR_DESCRIPTION_PROMPT);
                          }
                        }}
                      />
                    </div>
                    {prUseCustomPrompt ? (
                      <Textarea
                        aria-label={t('versionControl.customPrPromptLabel')}
                        value={prCustomPrompt}
                        onChange={(event) =>
                          setPrCustomPrompt(event.target.value)
                        }
                        placeholder={t(
                          'versionControl.customPrPromptPlaceholder'
                        )}
                        className="min-h-28 font-mono text-xs"
                      />
                    ) : null}
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="pr-description-cancel-btn"
                      onClick={handleCancelPrDescriptionDialog}
                    >
                      {i18n.t('panels:ui.multiAgent.cancel')}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      data-dialog-primary="true"
                      data-testid="pr-description-save-btn"
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
    </div>
  );
}
