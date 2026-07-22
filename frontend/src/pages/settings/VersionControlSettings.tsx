import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  FolderGit2,
  GitPullRequest,
  Github,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import {
  DEFAULT_COMMIT_REMINDER_PROMPT,
  DEFAULT_PR_DESCRIPTION_PROMPT,
  type Config,
} from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  type GitHubCliStatus,
  type GitVersionStatus,
  type VersionControlCliSettings,
  versionControlApi,
} from '@/lib/api';
import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';

function cloneConfig(config: Config): Config {
  return structuredClone(config);
}

function validateBranchPrefix(
  prefix: string,
  t: (key: string) => string
): string | null {
  if (!prefix.trim()) {
    return t('versionControl.branchPrefixEmpty');
  }
  if (prefix.includes(' ')) {
    return t('versionControl.branchPrefixNoSpaces');
  }
  if (prefix.startsWith('/') || prefix.endsWith('/')) {
    return t('versionControl.branchPrefixNoSlashEnds');
  }
  if (prefix.includes('//')) {
    return t('versionControl.branchPrefixNoDoubleSlash');
  }
  if (/[~^:?*[\\]/.test(prefix)) {
    return t('versionControl.branchPrefixInvalidChars');
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
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? cloneConfig(config) : null
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
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

  useEffect(() => {
    if (config && !dirty) {
      setDraft(cloneConfig(config));
    }
  }, [config, dirty]);

  const branchPrefixError = useMemo(
    () => validateBranchPrefix(draft?.git_branch_prefix || '', t),
    [draft?.git_branch_prefix, t]
  );

  const updateDraft = useCallback((patch: Partial<Config>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setDirty(true);
      return { ...prev, ...patch };
    });
  }, []);

  const refreshGit = useCallback(async () => {
    try {
      setGitLoading(true);
      setGitStatus(await versionControlApi.detectGit());
    } catch (error) {
      toast.error(t('versionControl.gitDetectFailed'), {
        description:
          error instanceof Error
            ? error.message
            : t('versionControl.gitDetectFailedDesc'),
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
          error instanceof Error
            ? error.message
            : t('versionControl.githubStatusFailedDesc'),
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
            error instanceof Error
              ? error.message
              : t('versionControl.settingsLoadFailedDesc'),
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
            error instanceof Error
              ? error.message
              : t('versionControl.githubStatusFailedDesc'),
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

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: t('versionControl.pickWorkspaceTitle'),
      description: t('versionControl.pickWorkspaceDescription'),
    });

    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    if (branchPrefixError) {
      toast.error(t('versionControl.branchPrefixInvalid'), {
        description: branchPrefixError,
      });
      return;
    }

    try {
      setSaving(true);
      const saved = await updateAndSaveConfig(draft);
      if (!saved) {
        throw new Error(t('versionControl.saveFailedDesc'));
      }
      setDirty(false);
      toast.success(t('versionControl.settingsSaved'), {
        description: t('versionControl.settingsSavedDesc'),
      });
    } catch (error) {
      toast.error(t('versionControl.saveFailed'), {
        description:
          error instanceof Error
            ? error.message
            : t('versionControl.saveFailedDesc'),
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
          error instanceof Error
            ? error.message
            : t('versionControl.gitPathTestFailedDesc'),
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
          error instanceof Error
            ? error.message
            : t('versionControl.gitSettingsSaveFailedDesc'),
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
      toast.error(t('versionControl.githubLoginTerminalFailed'), {
        description:
          error instanceof Error
            ? error.message
            : t('versionControl.githubLoginStartFailed'),
      });
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
          error instanceof Error
            ? error.message
            : t('versionControl.githubLogoutFailedDesc'),
      });
    } finally {
      setGithubLoading(false);
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

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('versionControl.title')}
        description={t('versionControl.description')}
      />

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

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>{t('versionControl.customGitPathLabel')}</Label>
                <p className="settings-row__description">
                  {t('versionControl.customGitPathDescription')}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={customGitPath}
                  onChange={(event) => setCustomGitPath(event.target.value)}
                  placeholder={t('versionControl.customGitPathPlaceholder')}
                />
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleTestGitPath}
                    disabled={gitLoading}
                  >
                    {gitLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
          icon={FolderGit2}
          title={t('versionControl.worktreeSectionTitle')}
          description={t('versionControl.worktreeSectionDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row settings-row--stacked">
              <div>
                <Label>{t('versionControl.workspaceDirLabel')}</Label>
                <p className="settings-row__description">
                  {t('versionControl.workspaceDirDescription')}
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={draft.workspace_dir ?? ''}
                  onChange={(event) =>
                    updateDraft({ workspace_dir: event.target.value || null })
                  }
                  placeholder={t('versionControl.workspaceDirPlaceholder')}
                />
                <Button
                  variant="outline"
                  type="button"
                  onClick={handleBrowseWorkspaceDir}
                >
                  {t('versionControl.browse')}
                </Button>
              </div>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>{t('versionControl.branchPrefixLabel')}</Label>
                <p className="settings-row__description">
                  {t('versionControl.branchPrefixDescription')}
                </p>
              </div>
              <Input
                value={draft.git_branch_prefix}
                onChange={(event) =>
                  updateDraft({ git_branch_prefix: event.target.value.trim() })
                }
                placeholder="vibex"
                aria-invalid={Boolean(branchPrefixError)}
              />
              {branchPrefixError ? (
                <p className="text-sm text-destructive">{branchPrefixError}</p>
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
              <Label>{t('versionControl.enableCommitReminderLabel')}</Label>
              <p className="settings-row__description">
                {t('versionControl.enableCommitReminderDescription')}
              </p>
            </div>
            <Switch
              checked={draft.commit_reminder_enabled ?? true}
              onCheckedChange={(checked) =>
                updateDraft({ commit_reminder_enabled: checked })
              }
            />
          </div>
          {draft.commit_reminder_enabled ? (
            <div className="space-y-4">
              <div className="settings-row">
                <div>
                  <Label>{t('versionControl.customCommitPromptLabel')}</Label>
                  <p className="settings-row__description">
                    {t('versionControl.customCommitPromptDescription')}
                  </p>
                </div>
                <Switch
                  checked={draft.commit_reminder_prompt != null}
                  onCheckedChange={(checked) =>
                    updateDraft({
                      commit_reminder_prompt: checked
                        ? DEFAULT_COMMIT_REMINDER_PROMPT
                        : null,
                    })
                  }
                />
              </div>
              <Textarea
                value={
                  draft.commit_reminder_prompt ?? DEFAULT_COMMIT_REMINDER_PROMPT
                }
                disabled={draft.commit_reminder_prompt == null}
                onChange={(event) =>
                  updateDraft({ commit_reminder_prompt: event.target.value })
                }
                rows={7}
              />
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          icon={GitPullRequest}
          title={t('versionControl.prSectionTitle')}
          description={t('versionControl.prSectionDescription')}
        >
          <div className="settings-row">
            <div>
              <Label>{t('versionControl.autoPrDescriptionLabel')}</Label>
              <p className="settings-row__description">
                {t('versionControl.autoPrDescriptionDescription')}
              </p>
            </div>
            <Switch
              checked={draft.pr_auto_description_enabled ?? false}
              onCheckedChange={(checked) =>
                updateDraft({ pr_auto_description_enabled: checked })
              }
            />
          </div>
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('versionControl.customPrPromptLabel')}</Label>
                <p className="settings-row__description">
                  {t('versionControl.customPrPromptDescription')}
                </p>
              </div>
              <Switch
                checked={draft.pr_auto_description_prompt != null}
                onCheckedChange={(checked) =>
                  updateDraft({
                    pr_auto_description_prompt: checked
                      ? DEFAULT_PR_DESCRIPTION_PROMPT
                      : null,
                  })
                }
              />
            </div>
            <Textarea
              value={
                draft.pr_auto_description_prompt ??
                DEFAULT_PR_DESCRIPTION_PROMPT
              }
              disabled={draft.pr_auto_description_prompt == null}
              onChange={(event) =>
                updateDraft({ pr_auto_description_prompt: event.target.value })
              }
              rows={7}
            />
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
              <StatusLine
                ok={Boolean(githubStatus?.authenticated)}
                loading={githubLoading}
              >
                {githubStatus?.authenticated
                  ? (githubStatus.username ?? t('versionControl.loggedIn'))
                  : githubStatus?.gh_installed
                    ? (githubStatus.message ??
                      t('versionControl.notLoggedIn'))
                    : t('versionControl.ghNotInstalled')}
              </StatusLine>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>GitHub Host</Label>
                <p className="settings-row__description">
                  {t('versionControl.githubHostDescription')}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={githubHost}
                  onChange={(event) => setGithubHost(event.target.value)}
                  placeholder="github.com"
                />
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={refreshGithub}
                    disabled={githubLoading}
                  >
                    {githubLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {t('versionControl.refresh')}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleOpenGithubLogin}
                    disabled={githubLoading}
                  >
                    <LogIn className="mr-2 h-4 w-4" />
                    {t('versionControl.login')}
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleGithubLogout}
                    disabled={githubLoading || !githubStatus?.authenticated}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    {t('versionControl.logout')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={handleReset}
        onSave={handleSave}
        disabled={Boolean(branchPrefixError)}
      />
    </div>
  );
}
