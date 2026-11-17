import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Globe,
  Loader2,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Project } from 'shared/types';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { fileSystemApi, projectsApi } from '@/lib/api';
import { APP_NAME } from '@/lib/branding';
import { useLocalDesktopHost } from '@/lib/desktopShell';
import { pickHostDirectories } from '@/lib/hostFs';
import { orderImportedProjects } from '@/lib/importedProject';
import { useOptionalBasicGuide } from '@/features/basic-guide';
import { cn } from '@/lib/utils';

const EMPTY_PROJECT_IDS: readonly string[] = [];

export type OnboardingProjectsPriorStep =
  | 'intro'
  | 'configure'
  | 'history'
  | 'appearance';

function errorSummary(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof (cause as Record<string, unknown>).message === 'string'
  ) {
    return (cause as Record<string, string>).message;
  }
  return String(cause);
}

function projectNameFromPath(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed || dirPath;
}

function StageActionRow({
  icon: Icon,
  title,
  description,
  primary = false,
  compact = false,
  disabled = false,
  onClick,
  guideId,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  primary?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onClick: () => void;
  guideId?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-basic-guide={guideId}
      data-testid={testId}
      className={cn(
        'group flex w-full items-center rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60',
        compact ? 'gap-2.5 px-3 py-2.5' : 'gap-3.5 px-4 py-3',
        primary
          ? 'border-primary/30 bg-primary/[0.06] hover:border-primary/50 hover:bg-primary/[0.1]'
          : 'border-border/70 bg-foreground/[0.02] hover:border-border hover:bg-foreground/[0.05]'
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-lg transition-colors',
          compact ? 'h-8 w-8' : 'h-9 w-9',
          primary
            ? 'bg-primary/15 text-primary'
            : 'bg-muted text-muted-foreground group-hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {description}
        </span>
      </span>

      <ArrowRight
        className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

export function OnboardingProjects({
  initialProjectIds = EMPTY_PROJECT_IDS,
  active = true,
  onBack,
  onNavigateStep,
  onFinish,
}: {
  initialProjectIds?: readonly string[];
  /** Only the visible page owns the onboarding title anchor. */
  active?: boolean;
  onBack: () => void;
  onNavigateStep?: (step: OnboardingProjectsPriorStep) => void;
  onFinish: (projectIds: string[]) => Promise<void>;
}) {
  const { t, i18n } = useTranslation(['dialogs', 'panels', 'app']);
  const localDesktopHost = useLocalDesktopHost();
  const isZh = (i18n.resolvedLanguage ?? i18n.language ?? '').startsWith('zh');
  const queryClient = useQueryClient();
  const basicGuide = useOptionalBasicGuide();

  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadRequestRef = useRef(0);
  const [importedIds, setImportedIds] = useState<Set<string>>(
    () => new Set(initialProjectIds)
  );
  const initialProjectIdsRef = useRef(initialProjectIds);
  initialProjectIdsRef.current = initialProjectIds;
  const importedIdsKey = initialProjectIds.join('\0');

  const loadProjects = useCallback(async () => {
    const next = orderImportedProjects(
      (await projectsApi.getAll()).filter((project) => !project.hidden)
    );
    if (mounted.current) setProjects(next);
    return next;
  }, []);

  const refreshProjects = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (mounted.current) setError(null);
    try {
      const next = await loadProjects();
      if (mounted.current && loadRequestRef.current === requestId) {
        setLoading(false);
      }
      return next;
    } catch (cause) {
      if (mounted.current && loadRequestRef.current === requestId) {
        setError(errorSummary(cause));
        setLoading(false);
      }
      return undefined;
    }
  }, [loadProjects]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const incomingIds = initialProjectIdsRef.current;
    if (incomingIds.length === 0) return;
    setImportedIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of incomingIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [importedIdsKey, queryClient]);

  useEffect(() => {
    if (!active) return;
    void refreshProjects();
  }, [active, importedIdsKey, refreshProjects]);

  useEffect(() => {
    if (!active || loading) return;
    if (basicGuide?.state.phase === 'idle') {
      basicGuide.start(false);
    }
  }, [active, basicGuide, loading]);

  useEffect(() => {
    if (active) document.getElementById('onboarding-title')?.focus();
  }, [active]);

  const mergeProjects = useCallback(
    (incoming: Project[], markImported = true) => {
      if (incoming.length === 0) return;
      setProjects((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const project of incoming) {
          byId.set(project.id, project);
        }
        return orderImportedProjects([...byId.values()]);
      });
      if (markImported) {
        setImportedIds((current) => {
          const next = new Set(current);
          for (const project of incoming) {
            next.add(project.id);
          }
          return next;
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    [queryClient]
  );

  const importDirectoryPaths = useCallback(
    async (rawPaths: string[]) => {
      const uniquePaths = Array.from(
        new Set(rawPaths.map((p) => p.trim()).filter(Boolean))
      );
      if (uniquePaths.length === 0) return;

      setImporting(true);
      setError(null);
      const created: Project[] = [];
      const failures: string[] = [];

      for (const folderPath of uniquePaths) {
        try {
          const preview = await projectsApi
            .previewImport(folderPath)
            .catch(() => null);
          const name = projectNameFromPath(folderPath);
          const isGit = Boolean(preview?.is_git);
          const project = await projectsApi.create({
            name,
            rootPath: folderPath,
            repositories: isGit
              ? [{ display_name: name, git_repo_path: folderPath }]
              : [],
          });
          created.push(project);
        } catch (cause) {
          failures.push(
            `${projectNameFromPath(folderPath)}: ${errorSummary(cause)}`
          );
        }
      }

      if (mounted.current) {
        mergeProjects(created, true);
        if (failures.length > 0) {
          setError(failures.join('; '));
        }
        setImporting(false);
      }
    },
    [mergeProjects]
  );

  const handleOpenFolders = useCallback(async () => {
    setError(null);
    setDialogOpen(true);
    try {
      const picked = await pickHostDirectories({
        title: t('app:welcomePage.selectFolder'),
      });
      if (picked.length > 0) {
        await importDirectoryPaths(picked);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(errorSummary(cause));
      }
    } finally {
      if (mounted.current) {
        setDialogOpen(false);
      }
    }
  }, [importDirectoryPaths, t]);

  const handleCreateProject = useCallback(async () => {
    setError(null);
    setDialogOpen(true);
    try {
      const result = await ProjectFormDialog.show({});
      if (result?.status === 'saved' && result.project) {
        mergeProjects([result.project], true);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(errorSummary(cause));
      }
    } finally {
      if (mounted.current) {
        setDialogOpen(false);
      }
    }
  }, [mergeProjects]);

  const handleCloneRepo = useCallback(async () => {
    setError(null);
    setDialogOpen(true);
    try {
      const result = await CloneRepoDialog.show();
      if (result?.status === 'cloned') {
        const name = result.repo.display_name || result.repo.name;
        const created = await projectsApi.create({
          name,
          repositories: [
            { display_name: name, git_repo_path: result.repo.path },
          ],
        });
        mergeProjects([created], true);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(errorSummary(cause));
      }
    } finally {
      if (mounted.current) {
        setDialogOpen(false);
      }
    }
  }, [mergeProjects]);

  useEffect(() => {
    if (!localDesktopHost || !active) {
      setDropActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            setDropActive(true);
            return;
          }
          if (payload.type === 'leave') {
            setDropActive(false);
            return;
          }
          if (payload.type !== 'drop') return;

          setDropActive(false);
          const droppedPaths = payload.paths
            .map((candidate) => candidate.trim())
            .filter(Boolean);
          if (droppedPaths.length === 0) return;

          void (async () => {
            const results = await Promise.all(
              droppedPaths.map(async (candidate) => {
                try {
                  await fileSystemApi.list(candidate);
                  return candidate;
                } catch {
                  return null;
                }
              })
            );
            const validPaths = results.filter(
              (item): item is string => item !== null
            );
            if (validPaths.length === 0) {
              if (mounted.current) {
                setError(t('app:welcomePage.dropFolderInvalid'));
              }
              return;
            }
            await importDirectoryPaths(validPaths);
          })();
        })
      )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, importDirectoryPaths, localDesktopHost, t]);

  const enterProject = useCallback(
    async (selectedId: string) => {
      if (busy || importing) return;
      setBusy(true);
      setError(null);
      try {
        const orderedIds = [
          selectedId,
          ...projects
            .filter((project) => project.id !== selectedId)
            .map((project) => project.id),
        ];
        await onFinish(orderedIds);
      } catch (cause) {
        if (mounted.current) {
          setError(errorSummary(cause));
        }
      } finally {
        if (mounted.current) {
          setBusy(false);
        }
      }
    },
    [busy, importing, onFinish, projects]
  );

  const globalProject = useMemo(
    () => projects.find((candidate) => candidate.is_home) ?? null,
    [projects]
  );

  const hasProjectList = useMemo(
    () => projects.some((project) => !project.is_home) || importedIds.size > 0,
    [importedIds.size, projects]
  );

  const actionBusy = busy || importing;
  const guideTargetsActive = active && !loading && !dialogOpen;

  return (
    <main
      className="onboarding-projects-step onboarding-zero-projects-step relative"
      inert={dialogOpen}
      data-testid="onboarding-projects-stage"
    >
      {dropActive ? (
        <div
          className="welcome-page-drop-overlay"
          role="status"
          aria-label={t('app:welcomePage.dropFolder')}
        >
          <FolderOpen aria-hidden="true" />
          <strong>{t('app:welcomePage.dropFolder')}</strong>
        </div>
      ) : null}

      <nav
        className="onboarding-journey onboarding-appearance-journey"
        aria-label={t('dialogs:onboarding.stepsLabel')}
      >
        <div className="onboarding-journey-trail">
          {(
            [
              ['intro', 'welcomeStep'],
              ['configure', 'agentStep'],
              ['history', 'historyStep'],
              ['appearance', 'appearanceStep'],
            ] as const
          ).map(([stepId, key]) => {
            const interactive =
              Boolean(onNavigateStep) || stepId === 'appearance';
            return (
              <span key={stepId} className="onboarding-journey-item">
                {interactive ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      onNavigateStep ? onNavigateStep(stepId) : onBack()
                    }
                  >
                    {t(`dialogs:onboarding.${key}`)}
                  </button>
                ) : (
                  <span>{t(`dialogs:onboarding.${key}`)}</span>
                )}
                <ChevronRight aria-hidden="true" />
              </span>
            );
          })}
          <span aria-current="step">{t('dialogs:onboarding.projectStep')}</span>
        </div>
        <span
          className="onboarding-journey-count tabular-nums"
          aria-hidden="true"
        >
          5 / 5
        </span>
      </nav>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto py-2">
        <div
          className={cn(
            'w-full transition-all duration-200',
            hasProjectList ? 'max-w-4xl' : 'max-w-lg'
          )}
        >
          <div className="mb-7 flex items-center gap-3.5">
            <Logo showText={false} size="hero" className="-ml-2 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {APP_NAME} · {t('app:welcomePage.tagline')}
              </div>
              <h1
                id={active ? 'onboarding-title' : undefined}
                tabIndex={-1}
                className="mt-1 text-xl font-semibold tracking-tight text-foreground"
              >
                {t(
                  'panels:projectSwitcher.zeroStageTitle',
                  '导入或创建一个项目开始协作'
                )}
              </h1>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {localDesktopHost
                  ? t(
                      'panels:projectSwitcher.zeroStageSubtitle',
                      '打开现有代码目录、创建新项目或克隆远端仓库，也可直接将文件夹拖入当前窗口。'
                    )
                  : t('panels:projectSwitcher.zeroStageSubtitleRemote', {
                      defaultValue: isZh
                        ? '打开主机上的已有代码目录、创建新项目或克隆远端仓库。'
                        : 'Open an existing directory on the host, create a new project, or clone a remote repository.',
                    })}
              </p>
            </div>
          </div>

          {error ? (
            <p className="onboarding-inline-error mb-4" role="alert">
              {error}
            </p>
          ) : null}

          {loading ? (
            <div
              className="flex min-h-[180px] items-center justify-center gap-2.5 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>{t('dialogs:onboarding.loadingProjects')}</span>
            </div>
          ) : hasProjectList ? (
            <div
              data-testid="onboarding-projects-split"
              className="grid grid-cols-1 items-start gap-6 md:grid-cols-[290px_minmax(0,1fr)]"
            >
              <div className="w-full space-y-2.5">
                <StageActionRow
                  icon={FolderOpen}
                  primary
                  compact
                  disabled={actionBusy}
                  title={t('app:welcomePage.selectFolder')}
                  description={t(
                    'panels:projectSwitcher.openFolderDesc',
                    '导入本地已有代码目录或工作文件夹'
                  )}
                  onClick={() => void handleOpenFolders()}
                  testId="zero-project-open-folder"
                />

                <StageActionRow
                  icon={Plus}
                  compact
                  disabled={actionBusy}
                  title={t('app:welcomePage.createNewProject')}
                  description={t(
                    'panels:projectSwitcher.createProjectDesc',
                    '初始化一个新的本地项目目录'
                  )}
                  onClick={() => void handleCreateProject()}
                  testId="zero-project-create-project"
                />

                <StageActionRow
                  icon={GitBranch}
                  compact
                  disabled={actionBusy}
                  title={t('app:welcomePage.cloneRepo')}
                  description={t(
                    'panels:projectSwitcher.cloneRepoDesc',
                    '从 Git 远端地址克隆仓库并打开'
                  )}
                  onClick={() => void handleCloneRepo()}
                  testId="zero-project-clone-repo"
                />

                {importedIds.size > 1 ? (
                  <p
                    className="flex items-center gap-1.5 pt-1 text-xs font-medium text-primary"
                    role="status"
                  >
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {t('dialogs:onboarding.projectsMultiImported', {
                        count: importedIds.size,
                      })}
                    </span>
                  </p>
                ) : null}

                <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                  {localDesktopHost
                    ? t(
                        'panels:projectSwitcher.dropFolderHint',
                        '支持将本地项目文件夹直接拖入窗口打开'
                      )
                    : t('panels:projectSwitcher.remoteFolderHint', {
                        defaultValue: isZh
                          ? '通过上方“选择文件夹”浏览主机目录'
                          : 'Use "Select Folder" above to browse directories on the host',
                      })}
                </p>
              </div>

              <section
                aria-label={t('dialogs:onboarding.projectListTitle')}
                className="min-w-0 space-y-2.5"
              >
                <h2 className="text-sm font-semibold text-foreground">
                  {t('dialogs:onboarding.projectListTitle')}
                </h2>

                <div
                  data-basic-guide={
                    guideTargetsActive ? 'welcome-project-list' : undefined
                  }
                  data-testid="onboarding-project-list"
                  className="rounded-xl border border-border/70 bg-foreground/[0.02] p-2.5"
                >
                  <ul className="max-h-[320px] space-y-1.5 overflow-y-auto pr-0.5">
                    {projects.map((project) => {
                      const title = project.is_home
                        ? t('app:welcomePage.globalProject')
                        : project.name;
                      const subtitle = project.is_home
                        ? t('dialogs:onboarding.globalDescription')
                        : project.root_path;
                      return (
                        <li key={project.id}>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => void enterProject(project.id)}
                            data-testid={`onboarding-project-item-${project.id}`}
                            className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
                              {project.is_home ? (
                                <Globe className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <FolderOpen
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              )}
                            </span>

                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {title}
                                </span>
                                {importedIds.has(project.id) ? (
                                  <span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                                    {t(
                                      'dialogs:onboarding.importedProjectBadge'
                                    )}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {subtitle}
                              </span>
                            </span>

                            <ArrowRight
                              className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                              aria-hidden="true"
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                <StageActionRow
                  icon={FolderOpen}
                  primary
                  disabled={actionBusy}
                  title={t('app:welcomePage.selectFolder')}
                  description={t(
                    'panels:projectSwitcher.openFolderDesc',
                    '导入本地已有代码目录或工作文件夹'
                  )}
                  onClick={() => void handleOpenFolders()}
                  guideId={
                    guideTargetsActive ? 'welcome-select-folder' : undefined
                  }
                  testId="zero-project-open-folder"
                />

                <StageActionRow
                  icon={Plus}
                  disabled={actionBusy}
                  title={t('app:welcomePage.createNewProject')}
                  description={t(
                    'panels:projectSwitcher.createProjectDesc',
                    '初始化一个新的本地项目目录'
                  )}
                  onClick={() => void handleCreateProject()}
                  guideId={
                    guideTargetsActive ? 'welcome-create-project' : undefined
                  }
                  testId="zero-project-create-project"
                />

                <StageActionRow
                  icon={GitBranch}
                  disabled={actionBusy}
                  title={t('app:welcomePage.cloneRepo')}
                  description={t(
                    'panels:projectSwitcher.cloneRepoDesc',
                    '从 Git 远端地址克隆仓库并打开'
                  )}
                  onClick={() => void handleCloneRepo()}
                  testId="zero-project-clone-repo"
                />
              </div>

              {!projects.length ? (
                <div className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => void refreshProjects()}
                  >
                    {t('dialogs:onboarding.retry')}
                  </Button>
                </div>
              ) : null}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4 text-xs text-muted-foreground">
                <span>
                  {localDesktopHost
                    ? t(
                        'panels:projectSwitcher.dropFolderHint',
                        '支持将本地项目文件夹直接拖入窗口打开'
                      )
                    : t('panels:projectSwitcher.remoteFolderHint', {
                        defaultValue: isZh
                          ? '通过上方“选择文件夹”浏览主机目录'
                          : 'Use "Select Folder" above to browse directories on the host',
                      })}
                </span>

                {globalProject ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    data-basic-guide={
                      guideTargetsActive ? 'welcome-global-project' : undefined
                    }
                    data-testid="zero-project-enter-global"
                    onClick={() => void enterProject(globalProject.id)}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                  >
                    <Sparkles
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {t(
                        'panels:projectSwitcher.enterGlobalProject',
                        '进入全局临时空间（无需绑定代码目录）'
                      )}
                    </span>
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="onboarding-page-footer">
        <Button variant="ghost" disabled={actionBusy} onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('dialogs:onboarding.back')}
        </Button>
        {importing || busy ? (
          <span
            className="inline-flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>{t('app:welcomePage.processing')}</span>
          </span>
        ) : null}
      </footer>
    </main>
  );
}
