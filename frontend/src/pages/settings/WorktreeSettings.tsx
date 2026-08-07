import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderGit2, GitFork, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  projectsApi,
  type ProjectWorktreeSettings,
  type WorktreeCleanupStatus,
  worktreeSettingsApi,
} from '@/lib/api';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';
import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';

const EMPTY_SETTINGS: ProjectWorktreeSettings = {
  create_command: null,
  delete_command: null,
  cleanup_prompt_enabled: false,
  cleanup_prompt_threshold: 5,
};

function cloneSettings(settings: ProjectWorktreeSettings) {
  return { ...settings };
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

export function WorktreeSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, updateAndSaveConfig } = useUserSystem();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState<ProjectWorktreeSettings>(EMPTY_SETTINGS);
  const [saved, setSaved] = useState<ProjectWorktreeSettings>(EMPTY_SETTINGS);
  const [status, setStatus] = useState<WorktreeCleanupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const [worktreeDraft, setWorktreeDraft] = useState({
    workspace_dir: null as string | null,
    git_branch_prefix: '',
  });
  const [worktreeSaving, setWorktreeSaving] = useState(false);
  const worktreeEditedRef = useRef(false);
  const worktreeDirty =
    config !== null &&
    (worktreeDraft.workspace_dir !== (config.workspace_dir ?? null) ||
      worktreeDraft.git_branch_prefix !== config.git_branch_prefix);
  const worktreeBranchPrefixError = useMemo(
    () => validateBranchPrefix(worktreeDraft.git_branch_prefix, t),
    [worktreeDraft.git_branch_prefix, t]
  );

  // config 就绪前不渲染编辑值；就绪后同步一次，之后只在用户未编辑时跟随
  // 外部 config 变化，避免把加载前的空 draft 覆盖回全局配置。
  useEffect(() => {
    if (config === null || worktreeEditedRef.current) return;
    setWorktreeDraft({
      workspace_dir: config.workspace_dir ?? null,
      git_branch_prefix: config.git_branch_prefix,
    });
  }, [config]);

  const updateWorktreeDraft = useCallback(
    (patch: Partial<typeof worktreeDraft>) => {
      worktreeEditedRef.current = true;
      setWorktreeDraft((current) => ({ ...current, ...patch }));
    },
    []
  );

  const handleBrowseWorkspaceDir = async () => {
    const result = await FolderPickerDialog.show({
      value: worktreeDraft.workspace_dir ?? '',
      title: t('versionControl.pickWorkspaceTitle'),
      description: t('versionControl.pickWorkspaceDescription'),
    });
    if (result) {
      updateWorktreeDraft({ workspace_dir: result });
    }
  };

  const resetWorktreeSettings = () => {
    worktreeEditedRef.current = false;
    setWorktreeDraft({
      workspace_dir: config?.workspace_dir ?? null,
      git_branch_prefix: config?.git_branch_prefix ?? '',
    });
  };

  const saveWorktreeSettings = async () => {
    if (worktreeBranchPrefixError) {
      toast.error(t('versionControl.branchPrefixInvalid'), {
        description: worktreeBranchPrefixError,
      });
      return;
    }
    setWorktreeSaving(true);
    try {
      const savedConfig = await updateAndSaveConfig({
        workspace_dir: worktreeDraft.workspace_dir,
        git_branch_prefix: worktreeDraft.git_branch_prefix,
      });
      if (!savedConfig) {
        throw new Error(t('versionControl.saveFailedDesc'));
      }
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
      setWorktreeSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadProjects = async () => {
      try {
        const nextProjects = await projectsApi.getAll();
        if (cancelled) return;
        setProjects(nextProjects);
        setProjectId((current) => current || nextProjects[0]?.id || '');
      } catch (error) {
        toast.error(t('worktrees.loadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        setLoading(false);
      }
    };
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const loadSettings = () => {
      if (dirtyRef.current) return;
      setLoading(true);
      void Promise.all([
        worktreeSettingsApi.get(projectId),
        worktreeSettingsApi.getCleanupStatus(projectId),
      ])
        .then(([settings, nextStatus]) => {
          if (cancelled) return;
          setDraft(cloneSettings(settings));
          setSaved(cloneSettings(settings));
          setStatus(nextStatus);
        })
        .catch((error) => {
          if (cancelled) return;
          toast.error(t('worktrees.loadFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    loadSettings();
    window.addEventListener('focus', loadSettings);
    window.addEventListener(SETTINGS_CHANGED_EVENT, loadSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', loadSettings);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, loadSettings);
    };
  }, [projectId, t]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  );
  dirtyRef.current = dirty;

  const updateDraft = useCallback((patch: Partial<ProjectWorktreeSettings>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const save = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const next = await worktreeSettingsApi.update(projectId, draft);
      setDraft(cloneSettings(next));
      setSaved(cloneSettings(next));
      setStatus(await worktreeSettingsApi.getCleanupStatus(projectId));
      toast.success(t('worktrees.saved'));
    } catch (error) {
      toast.error(t('worktrees.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }, [draft, projectId, t]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-20">
      <SettingsPageHeader
        title={t('worktrees.title')}
        description={t('worktrees.description')}
      />

      <SettingsSection
        icon={FolderGit2}
        title={t('versionControl.worktreeSectionTitle')}
        description={t('versionControl.worktreeSectionDescription')}
      >
        <div className="space-y-4">
          <div className="settings-row settings-row--stacked">
            <div>
              <Label htmlFor="worktree-workspace-dir">
                {t('versionControl.workspaceDirLabel')}
              </Label>
              <p className="settings-row__description">
                {t('versionControl.workspaceDirDescription')}
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                id="worktree-workspace-dir"
                value={worktreeDraft.workspace_dir ?? ''}
                onChange={(event) =>
                  updateWorktreeDraft({
                    workspace_dir: event.target.value || null,
                  })
                }
                placeholder={t('versionControl.workspaceDirPlaceholder')}
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => void handleBrowseWorkspaceDir()}
              >
                {t('versionControl.browse')}
              </Button>
            </div>
          </div>

          <div className="settings-row settings-row--stacked">
            <div>
              <Label htmlFor="worktree-branch-prefix">
                {t('versionControl.branchPrefixLabel')}
              </Label>
              <p className="settings-row__description">
                {t('versionControl.branchPrefixDescription')}
              </p>
            </div>
            <Input
              id="worktree-branch-prefix"
              value={worktreeDraft.git_branch_prefix}
              onChange={(event) =>
                updateWorktreeDraft({
                  git_branch_prefix: event.target.value.trim(),
                })
              }
              placeholder="vibex"
              aria-invalid={Boolean(worktreeDirty && worktreeBranchPrefixError)}
            />
            {worktreeDirty && worktreeBranchPrefixError ? (
              <p className="text-sm text-destructive">
                {worktreeBranchPrefixError}
              </p>
            ) : null}
          </div>

          {worktreeDirty ? (
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={resetWorktreeSettings}
                disabled={worktreeSaving}
              >
                {t('common:discard')}
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => void saveWorktreeSettings()}
                disabled={Boolean(worktreeBranchPrefixError) || worktreeSaving}
              >
                {worktreeSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {t('common:save')}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={GitFork}
        title={t('worktrees.projectTitle')}
        description={t('worktrees.projectDescription')}
      >
        <div className="settings-row items-center gap-4 px-4 py-3">
          <Label htmlFor="worktree-project" className="min-w-32">
            {t('worktrees.projectLabel')}
          </Label>
          <select
            id="worktree-project"
            className="raised-control h-8 min-w-0 flex-1 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={loading || projects.length === 0}
          >
            {projects.length === 0 ? (
              <option value="">{t('worktrees.noProjects')}</option>
            ) : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="border-t px-4 py-3">
          <h4 className="text-sm font-semibold">
            {t('worktrees.commandsTitle')}
          </h4>
          <div className="mt-3 space-y-2">
            <Label htmlFor="worktree-create-command">
              {t('worktrees.createCommand')}
            </Label>
            <Textarea
              id="worktree-create-command"
              className="min-h-20 font-mono text-xs"
              value={draft.create_command ?? ''}
              onChange={(event) =>
                updateDraft({ create_command: event.target.value || null })
              }
              placeholder={t('worktrees.createCommandPlaceholder')}
              disabled={loading || !projectId}
            />
            <p className="text-xs text-muted-foreground">
              {t('worktrees.createCommandHint')}
            </p>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="worktree-delete-command">
              {t('worktrees.deleteCommand')}
            </Label>
            <Textarea
              id="worktree-delete-command"
              className="min-h-20 font-mono text-xs"
              value={draft.delete_command ?? ''}
              onChange={(event) =>
                updateDraft({ delete_command: event.target.value || null })
              }
              placeholder={t('worktrees.deleteCommandPlaceholder')}
              disabled={loading || !projectId}
            />
            <p className="text-xs text-muted-foreground">
              {t('worktrees.deleteCommandHint')}
            </p>
          </div>
        </div>

        <div className="border-t px-4 py-3">
          <h4 className="text-sm font-semibold">
            {t('worktrees.cleanupTitle')}
          </h4>
          <div className="mt-3 settings-row items-center justify-between gap-4">
            <div>
              <Label htmlFor="worktree-cleanup-prompt">
                {t('worktrees.cleanupPrompt')}
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('worktrees.cleanupPromptHint')}
              </p>
            </div>
            <Switch
              id="worktree-cleanup-prompt"
              checked={draft.cleanup_prompt_enabled}
              onCheckedChange={(checked) =>
                updateDraft({ cleanup_prompt_enabled: checked })
              }
              disabled={loading || !projectId}
            />
          </div>
          <div className="mt-4 settings-row items-center justify-between gap-4">
            <Label htmlFor="worktree-cleanup-threshold">
              {t('worktrees.cleanupThreshold')}
            </Label>
            <Input
              id="worktree-cleanup-threshold"
              type="number"
              min={1}
              max={999}
              className="w-24 text-right"
              value={draft.cleanup_prompt_threshold}
              onChange={(event) =>
                updateDraft({
                  cleanup_prompt_threshold: Math.max(
                    1,
                    Number.parseInt(event.target.value, 10) || 1
                  ),
                })
              }
              disabled={loading || !projectId || !draft.cleanup_prompt_enabled}
            />
          </div>
          {status?.should_prompt ? (
            <div
              className="settings-row mt-4 gap-2 text-sm text-warning"
              role="status"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t('worktrees.cleanupRecommended', {
                  count: status.current_count,
                  threshold: status.threshold,
                })}
              </span>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(cloneSettings(saved))}
        onSave={() => void save()}
        disabled={!projectId || draft.cleanup_prompt_threshold < 1}
      />
    </div>
  );
}
