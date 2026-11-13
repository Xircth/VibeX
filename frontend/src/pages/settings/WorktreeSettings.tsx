import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderGit2, GitFork } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { FolderPickerDialog } from '@/components/dialogs/shared/FolderPickerDialog';
import { toast } from '@/components/ui/toast';
import { TextInput } from '@astryxdesign/core/TextInput';
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
import { cn } from '@/lib/utils';
import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
import { WorktreeProjectDetails } from './WorktreeProjectDetails';
import { EmptyState } from '@/components/ui/empty-state';

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
  if (!prefix) return null;
  if (prefix.includes(' ')) {
    return t('versionControl.branchPrefixNoSpaces');
  }
  if (prefix.startsWith('/') || prefix.endsWith('/')) {
    return t('versionControl.branchPrefixNoSlashEnds');
  }
  if (prefix.includes('//')) {
    return t('versionControl.branchPrefixNoDoubleSlash');
  }
  if (
    /[~^:?*[\\]/.test(prefix) ||
    [...prefix].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
    ) ||
    prefix.includes('..') ||
    prefix.includes('@{') ||
    prefix
      .split('/')
      .some((part) => part.startsWith('.') || part.endsWith('.lock'))
  ) {
    return t('versionControl.branchPrefixInvalidChars');
  }
  return null;
}

export function WorktreeSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, updateAndSaveConfig } = useUserSystem();
  const [globalSave, setGlobalSave] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [projectSave, setProjectSave] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState<ProjectWorktreeSettings>(EMPTY_SETTINGS);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [status, setStatus] = useState<WorktreeCleanupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const projectIdRef = useRef('');
  const [worktreeDraft, setWorktreeDraft] = useState({
    workspace_dir: null as string | null,
    git_branch_prefix: '',
  });
  const worktreeDraftRef = useRef(worktreeDraft);
  worktreeDraftRef.current = worktreeDraft;
  const worktreeEditedRef = useRef(false);
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  const worktreeBranchPrefixError = useMemo(
    () => validateBranchPrefix(worktreeDraft.git_branch_prefix, t),
    [worktreeDraft.git_branch_prefix, t]
  );
  const {
    writeNow: writeWorktreeNow,
    writeSettled: writeWorktreeSettled,
    flush: flushWorktree,
    holdingRef: worktreeHoldingRef,
  } = useLiveSettingsCommit(
    async (next: {
      workspace_dir: string | null;
      git_branch_prefix: string;
    }) => {
      const validPrefix = !validateBranchPrefix(next.git_branch_prefix, t);
      setGlobalSave('saving');
      try {
        const savedConfig = await updateAndSaveConfig({
          workspace_dir: next.workspace_dir,
          ...(validPrefix ? { git_branch_prefix: next.git_branch_prefix } : {}),
        });
        if (!savedConfig) {
          setGlobalSave('error');
          toast.error(t('versionControl.saveFailed'), {
            description: t('versionControl.saveFailedDesc'),
          });
          return;
        }
        const current = worktreeDraftRef.current;
        if (
          current.workspace_dir === next.workspace_dir &&
          current.git_branch_prefix === next.git_branch_prefix
        ) {
          worktreeEditedRef.current = false;
          if (validPrefix) {
            setWorktreeEdited(false);
            setGlobalSave('saved');
          } else {
            worktreeEditedRef.current = true;
            setGlobalSave('idle');
          }
        }
      } catch (error) {
        setGlobalSave('error');
        toast.error(t('versionControl.saveFailed'), {
          description:
            error instanceof Error
              ? error.message
              : t('versionControl.saveFailedDesc'),
        });
      }
    }
  );
  const {
    writeNow: writeProjectNow,
    writeSettled: writeProjectSettled,
    flush: flushProject,
    holdingRef: projectHoldingRef,
  } = useLiveSettingsCommit(async (next: ProjectWorktreeSettings) => {
    const project = projectIdRef.current;
    if (!project) return;
    setProjectSave('saving');
    try {
      const savedSettings = await worktreeSettingsApi.update(project, next);
      if (projectIdRef.current !== project) return;
      const cloned = cloneSettings(savedSettings);
      if (JSON.stringify(draftRef.current) === JSON.stringify(next)) {
        draftRef.current = cloned;
        setDraft(cloned);
        setProjectSave('saved');
      }
      const nextStatus = await worktreeSettingsApi.getCleanupStatus(project);
      if (projectIdRef.current === project) setStatus(nextStatus);
    } catch (error) {
      if (projectIdRef.current !== project) return;
      setProjectSave('error');
      toast.error(t('worktrees.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // config 就绪前不渲染编辑值；就绪后同步一次，之后只在用户未编辑时跟随
  // 外部 config 变化，避免把加载前的空 draft 覆盖回全局配置。
  useEffect(() => {
    if (
      config === null ||
      worktreeEditedRef.current ||
      worktreeHoldingRef.current
    ) {
      return;
    }
    const next = {
      workspace_dir: config.workspace_dir ?? null,
      git_branch_prefix: config.git_branch_prefix,
    };
    worktreeDraftRef.current = next;
    setWorktreeDraft(next);
  }, [config, worktreeHoldingRef]);

  const updateWorktreeDraft = useCallback(
    (patch: Partial<typeof worktreeDraft>) => {
      worktreeEditedRef.current = true;
      setGlobalSave('idle');
      setWorktreeEdited(true);
      const next = { ...worktreeDraftRef.current, ...patch };
      worktreeDraftRef.current = next;
      setWorktreeDraft(next);
      writeWorktreeSettled(next);
    },
    [writeWorktreeSettled]
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
    projectIdRef.current = projectId;
    const loadSettings = () => {
      if (projectHoldingRef.current) return;
      setLoading(true);
      void Promise.all([
        worktreeSettingsApi.get(projectId),
        worktreeSettingsApi.getCleanupStatus(projectId),
      ])
        .then(([settings, nextStatus]) => {
          if (cancelled || projectHoldingRef.current) return;
          const cloned = cloneSettings(settings);
          draftRef.current = cloned;
          setDraft(cloned);
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
  }, [projectHoldingRef, projectId, t]);

  const updateDraft = useCallback(
    (patch: Partial<ProjectWorktreeSettings>, settle = false) => {
      setProjectSave('idle');
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      setDraft(next);
      if (!projectIdRef.current) return;
      if (settle) writeProjectSettled(next);
      else writeProjectNow(next);
    },
    [writeProjectNow, writeProjectSettled]
  );

  const selectProject = (id: string) => {
    if (id === projectId) return;
    void (async () => {
      await flushProject();
      projectIdRef.current = id;
      setProjectSave('idle');
      setProjectId(id);
    })();
  };

  return (
    <div className="settings-content">
      <div className="settings-sections">
        <SettingsSection
          icon={FolderGit2}
          title={t('versionControl.worktreeSectionTitle')}
          description={t('versionControl.worktreeSectionDescription')}
        >
          <div className="space-y-4">
            <div className="settings-row">
              <div>
                <Label>{t('versionControl.workspaceDirLabel')}</Label>
                <p className="settings-row__description">
                  {t('versionControl.workspaceDirDescription')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <TextInput
                  label={t('versionControl.workspaceDirLabel')}
                  isLabelHidden
                  value={worktreeDraft.workspace_dir ?? ''}
                  onChange={(value) =>
                    updateWorktreeDraft({
                      workspace_dir: value || null,
                    })
                  }
                  onBlur={() => void flushWorktree()}
                  placeholder={t('versionControl.workspaceDirPlaceholder')}
                  width="220px"
                  className="w-[220px] [&_input]:text-sm"
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

            <div className="space-y-1.5">
              <div className="settings-row">
                <div>
                  <Label>{t('versionControl.branchPrefixLabel')}</Label>
                  <p className="settings-row__description">
                    {t('versionControl.branchPrefixDescription')}
                  </p>
                </div>
                <div className="shrink-0">
                  <TextInput
                    label={t('versionControl.branchPrefixLabel')}
                    isLabelHidden
                    value={worktreeDraft.git_branch_prefix}
                    onChange={(value) =>
                      updateWorktreeDraft({
                        git_branch_prefix: value,
                      })
                    }
                    onBlur={() => void flushWorktree()}
                    placeholder="vibex"
                    width="160px"
                    className="w-40 [&_input]:text-sm"
                    status={
                      worktreeEdited && worktreeBranchPrefixError
                        ? { type: 'error' }
                        : undefined
                    }
                  />
                </div>
              </div>
              {worktreeEdited && worktreeBranchPrefixError ? (
                <p className="text-right text-sm text-destructive">
                  {worktreeBranchPrefixError}
                </p>
              ) : null}
            </div>
            <div
              role="status"
              className="flex items-center justify-end gap-2 text-sm text-muted-foreground"
            >
              {globalSave === 'saving'
                ? t('worktrees.saving')
                : globalSave === 'saved'
                  ? t('worktrees.saved')
                  : globalSave === 'error'
                    ? t('worktrees.saveFailed')
                    : null}
              {globalSave === 'error' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => writeWorktreeNow(worktreeDraftRef.current)}
                >
                  {t('worktrees.retry')}
                </Button>
              )}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={GitFork}
          title={t('worktrees.projectTitle')}
          description={t('worktrees.projectDescription')}
          bare
        >
          <div className="settings-worktree-board">
            <div
              className="settings-worktree-board__list"
              role="listbox"
              aria-label={t('worktrees.projectLabel')}
            >
              {projects.length === 0 ? (
                <EmptyState
                  size="compact"
                  className="settings-worktree-board__empty"
                  icon={<FolderGit2 />}
                  title={t('worktrees.noProjects')}
                />
              ) : (
                projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected={project.id === projectId}
                    className={cn(
                      'settings-worktree-board__item',
                      project.id === projectId && 'is-selected'
                    )}
                    onClick={() => selectProject(project.id)}
                  >
                    {project.name}
                  </button>
                ))
              )}
            </div>

            <div className="settings-worktree-board__pane">
              <div
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                {projectSave === 'saving'
                  ? t('worktrees.saving')
                  : projectSave === 'saved'
                    ? t('worktrees.saved')
                    : projectSave === 'error'
                      ? t('worktrees.saveFailed')
                      : null}
                {projectSave === 'error' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => writeProjectNow(draftRef.current)}
                  >
                    {t('worktrees.retry')}
                  </Button>
                )}
              </div>
              <div className="space-y-3">
                <h4>{t('worktrees.commandsTitle')}</h4>
                <div className="space-y-2">
                  <Label htmlFor="worktree-create-command">
                    {t('worktrees.createCommand')}
                  </Label>
                  <Textarea
                    id="worktree-create-command"
                    className="min-h-20 font-mono text-sm"
                    value={draft.create_command ?? ''}
                    onChange={(event) =>
                      updateDraft(
                        {
                          create_command: event.target.value || null,
                        },
                        true
                      )
                    }
                    onBlur={() => void flushProject()}
                    placeholder={t('worktrees.createCommandPlaceholder')}
                    disabled={loading || !projectId}
                  />
                  <p className="settings-row__description">
                    {t('worktrees.createCommandHint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="worktree-delete-command">
                    {t('worktrees.deleteCommand')}
                  </Label>
                  <Textarea
                    id="worktree-delete-command"
                    className="min-h-20 font-mono text-sm"
                    value={draft.delete_command ?? ''}
                    onChange={(event) =>
                      updateDraft(
                        {
                          delete_command: event.target.value || null,
                        },
                        true
                      )
                    }
                    onBlur={() => void flushProject()}
                    placeholder={t('worktrees.deleteCommandPlaceholder')}
                    disabled={loading || !projectId}
                  />
                  <p className="settings-row__description">
                    {t('worktrees.deleteCommandHint')}
                  </p>
                </div>
              </div>

              {projectId && (
                <WorktreeProjectDetails key={projectId} projectId={projectId} />
              )}
              <div className="space-y-3">
                <h4>{t('worktrees.cleanupTitle')}</h4>
                <div className="settings-row items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="worktree-cleanup-prompt">
                      {t('worktrees.cleanupPrompt')}
                    </Label>
                    <p className="settings-row__description">
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
                <div className="settings-row items-center justify-between gap-4">
                  <Label htmlFor="worktree-cleanup-threshold">
                    {t('worktrees.cleanupThreshold')}
                  </Label>
                  <Input
                    id="worktree-cleanup-threshold"
                    type="number"
                    min={1}
                    max={999}
                    className="w-24 text-right tabular-nums"
                    value={draft.cleanup_prompt_threshold}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      if (
                        !Number.isInteger(parsed) ||
                        parsed < 1 ||
                        parsed > 999
                      ) {
                        return;
                      }
                      updateDraft({ cleanup_prompt_threshold: parsed }, true);
                    }}
                    onBlur={() => void flushProject()}
                    disabled={
                      loading || !projectId || !draft.cleanup_prompt_enabled
                    }
                  />
                </div>
                {status?.should_prompt ? (
                  <div
                    className="settings-row gap-2 text-sm text-warning"
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
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
