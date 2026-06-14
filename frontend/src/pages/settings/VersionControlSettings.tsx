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
import { toast } from 'sonner';
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

function validateBranchPrefix(prefix: string): string | null {
  if (!prefix.trim()) {
    return '分支前缀不能为空。';
  }
  if (prefix.includes(' ')) {
    return '分支前缀不能包含空格。';
  }
  if (prefix.startsWith('/') || prefix.endsWith('/')) {
    return '分支前缀不能以 / 开头或结尾。';
  }
  if (prefix.includes('//')) {
    return '分支前缀不能包含连续的 /。';
  }
  if (/[~^:?*[\\]/.test(prefix)) {
    return '分支前缀包含 Git 不支持的字符。';
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
    () => validateBranchPrefix(draft?.git_branch_prefix || ''),
    [draft?.git_branch_prefix]
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
      toast.error('Git 检测失败', {
        description: error instanceof Error ? error.message : '无法检测 Git。',
      });
    } finally {
      setGitLoading(false);
    }
  }, []);

  const refreshGithub = useCallback(async () => {
    try {
      setGithubLoading(true);
      const status = await versionControlApi.getGithubCliStatus(githubHost);
      setGithubStatus(status);
      setGithubHost(status.host);
    } catch (error) {
      toast.error('GitHub 状态检测失败', {
        description:
          error instanceof Error ? error.message : '无法检测 GitHub CLI。',
      });
    } finally {
      setGithubLoading(false);
    }
  }, [githubHost]);

  useEffect(() => {
    let cancelled = false;

    const loadCliSettings = async () => {
      try {
        const settings = await versionControlApi.getSettings();
        if (cancelled) return;
        setCliSettings(settings);
        setCustomGitPath(settings.git_custom_path ?? '');
      } catch (error) {
        toast.error('版本管理设置读取失败', {
          description:
            error instanceof Error ? error.message : '无法读取版本管理设置。',
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
        toast.error('GitHub 状态检测失败', {
          description:
            error instanceof Error ? error.message : '无法检测 GitHub CLI。',
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
  }, [refreshGit]);

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: draft?.workspace_dir ?? '',
      title: '选择工作区目录',
      description: '选择用于创建任务工作树和临时项目目录的根目录。',
    });

    if (result) {
      updateDraft({ workspace_dir: result });
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    if (branchPrefixError) {
      toast.error('分支前缀无效', {
        description: branchPrefixError,
      });
      return;
    }

    try {
      setSaving(true);
      const saved = await updateAndSaveConfig(draft);
      if (!saved) {
        throw new Error('无法保存版本管理设置。');
      }
      setDirty(false);
      toast.success('设置已保存', { description: '版本管理设置已更新。' });
    } catch (error) {
      toast.error('保存失败', {
        description:
          error instanceof Error ? error.message : '无法保存版本管理设置。',
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
        toast.success('Git 路径可用', {
          description: status.version ?? status.path ?? undefined,
        });
      } else {
        toast.warning('Git 路径不可用', {
          description: status.message ?? '无法执行该 Git 路径。',
        });
      }
    } catch (error) {
      toast.error('Git 路径测试失败', {
        description:
          error instanceof Error ? error.message : '无法测试 Git 路径。',
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
      toast.success('Git 设置已保存');
    } catch (error) {
      toast.error('Git 设置保存失败', {
        description:
          error instanceof Error ? error.message : '无法保存 Git 设置。',
      });
    } finally {
      setGitSaving(false);
    }
  };

  const handleOpenGithubLogin = async () => {
    try {
      await versionControlApi.openGithubCliLogin(githubHost);
      toast.info('已打开 GitHub CLI 登录终端');
    } catch (error) {
      toast.error('无法打开 GitHub 登录终端', {
        description:
          error instanceof Error ? error.message : 'GitHub CLI 登录启动失败。',
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
      toast.success('GitHub 已退出登录');
    } catch (error) {
      toast.error('GitHub 退出失败', {
        description:
          error instanceof Error ? error.message : '无法退出 GitHub CLI 登录。',
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
        title="版本管理"
        description="管理 Git、工作树、PR 描述和 GitHub 账号。"
      />

      <div className="settings-sections">
        <SettingsSection
          icon={TerminalSquare}
          title="Git 版本设置"
          description="检测当前 Git 环境，或指定一个自定义 Git 可执行文件。"
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>当前 Git</Label>
                <p className="settings-row__description">
                  {gitStatus?.path ?? '使用系统 PATH 中的 Git 命令。'}
                </p>
              </div>
              <StatusLine
                ok={Boolean(gitStatus?.installed)}
                loading={gitLoading}
              >
                {gitStatus?.installed
                  ? (gitStatus.version ?? 'Git 可用')
                  : (gitStatus?.message ?? '未检测到 Git')}
              </StatusLine>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>自定义 Git 路径</Label>
                <p className="settings-row__description">
                  为空时使用系统
                  PATH；保存后检测和后续设置页操作会优先使用该路径。
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={customGitPath}
                  onChange={(event) => setCustomGitPath(event.target.value)}
                  placeholder="例如 C:\\Program Files\\Git\\cmd\\git.exe"
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
                    检测
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
                    保存
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
                  使用系统 Git
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={FolderGit2}
          title="工作树设置"
          description="配置任务工作目录与分支命名规则。"
        >
          <div className="space-y-4">
            <div className="settings-row settings-row--stacked">
              <div>
                <Label>工作区目录</Label>
                <p className="settings-row__description">
                  用于创建任务工作树和临时项目目录。
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={draft.workspace_dir ?? ''}
                  onChange={(event) =>
                    updateDraft({ workspace_dir: event.target.value || null })
                  }
                  placeholder="选择工作区目录"
                />
                <Button
                  variant="outline"
                  type="button"
                  onClick={handleBrowseWorkspaceDir}
                >
                  选择
                </Button>
              </div>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>分支前缀</Label>
                <p className="settings-row__description">
                  新建任务分支时使用的默认前缀。
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
          title="提交提醒"
          description="配置任务完成后是否提示生成提交说明。"
        >
          <div className="settings-row">
            <div>
              <Label>启用提交提醒</Label>
              <p className="settings-row__description">
                当任务完成时提示检查未提交更改。
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
                  <Label>自定义提交提示词</Label>
                  <p className="settings-row__description">
                    关闭后使用系统默认提交提醒。
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
          title="PR 设置"
          description="配置 PR 描述生成的启用状态与默认提示词。"
        >
          <div className="settings-row">
            <div>
              <Label>自动生成 PR 描述</Label>
              <p className="settings-row__description">
                创建 PR 时自动准备描述草稿。
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
                <Label>自定义 PR 提示词</Label>
                <p className="settings-row__description">
                  关闭后使用系统默认 PR 描述模板。
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
          title="GitHub 账号"
          description="通过 GitHub CLI 管理用于仓库操作和 PR 流程的身份。"
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>登录状态</Label>
                <p className="settings-row__description">
                  {githubStatus?.gh_path ?? '检测 GitHub CLI 与当前登录账号。'}
                </p>
              </div>
              <StatusLine
                ok={Boolean(githubStatus?.authenticated)}
                loading={githubLoading}
              >
                {githubStatus?.authenticated
                  ? (githubStatus.username ?? '已登录')
                  : githubStatus?.gh_installed
                    ? (githubStatus.message ?? '未登录')
                    : '未安装 gh'}
              </StatusLine>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <Label>GitHub Host</Label>
                <p className="settings-row__description">
                  GitHub Enterprise 可填写自定义主机。
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
                    刷新
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleOpenGithubLogin}
                    disabled={githubLoading}
                  >
                    <LogIn className="mr-2 h-4 w-4" />
                    登录
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleGithubLogout}
                    disabled={githubLoading || !githubStatus?.authenticated}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    退出
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
