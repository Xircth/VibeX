import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useAppContextMenu } from '@/components/context-menu';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { toast } from '@/components/ui/toast';
import { resolveDroppedProjectFolder } from '@/components/welcome/welcomeFolderDrop';
import { useProjects } from '@/hooks/useProjects';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { fileSystemApi, projectsApi } from '@/lib/api';
import { APP_NAME } from '@/lib/branding';
import { paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

function ZeroStageActionRow({
  icon: Icon,
  title,
  description,
  primary = false,
  onClick,
  guideId,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  primary?: boolean;
  onClick: () => void;
  guideId?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-basic-guide={guideId}
      data-testid={testId}
      className={cn(
        'group flex w-full items-center gap-3.5 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        primary
          ? 'border-primary/30 bg-primary/[0.06] hover:border-primary/50 hover:bg-primary/[0.1]'
          : 'border-border/70 bg-foreground/[0.02] hover:border-border hover:bg-foreground/[0.05]'
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
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

export function WorkspaceZeroProjectStage() {
  const { t } = useTranslation(['panels', 'app', 'common']);
  const queryClient = useQueryClient();
  const { openSurfaceMenu } = useAppContextMenu();
  const { projects, isLoading } = useProjects();
  const switchProject = useProjectSwitcher();
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const removedProjectIds = useWindowProjectsStore(
    (state) => state.removedProjectIds
  );

  const [dropActive, setDropActive] = useState(false);
  const openingDroppedFolderRef = useRef(false);

  const globalProject = useMemo(
    () =>
      projects.find(
        (candidate) => candidate.is_home && !removedProjectIds[candidate.id]
      ) ?? null,
    [projects, removedProjectIds]
  );

  const openExistingFolder = useCallback(
    async (initialFolderPath?: string) => {
      const result = await ProjectFormDialog.show({
        autoOpenFolderPicker: !initialFolderPath,
        initialFolderPath,
      });
      if (result?.status === 'saved' && result.project) {
        ensureProjectOpen(result.project.id);
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        switchProject(
          result.project.id,
          paths.projectSessions(result.project.id)
        );
      }
    },
    [ensureProjectOpen, queryClient, switchProject]
  );

  const handleOpenFolder = useCallback(async () => {
    await openExistingFolder();
  }, [openExistingFolder]);

  const handleCreateProject = useCallback(async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  }, [ensureProjectOpen, queryClient, switchProject]);

  const handleCloneRepo = useCallback(async () => {
    const result = await CloneRepoDialog.show();
    if (result.status !== 'cloned') {
      return;
    }
    const name = result.repo.display_name || result.repo.name;
    try {
      const created = await projectsApi.create({
        name,
        repositories: [{ display_name: name, git_repo_path: result.repo.path }],
      });
      ensureProjectOpen(created.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      switchProject(created.id, paths.projectSessions(created.id));
    } catch (error) {
      toast.error(
        t('app:welcomePage.createProjectFailed', { error: String(error) })
      );
    }
  }, [ensureProjectOpen, queryClient, switchProject, t]);

  useEffect(() => {
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
          const droppedPaths = payload.paths;
          void (async () => {
            const resolved = await resolveDroppedProjectFolder(
              droppedPaths,
              fileSystemApi.list
            );
            if (resolved.ok === false) {
              toast.error(t('app:welcomePage.dropFolderInvalid'));
              return;
            }
            if (openingDroppedFolderRef.current) return;
            openingDroppedFolderRef.current = true;
            try {
              await openExistingFolder(resolved.path);
            } finally {
              openingDroppedFolderRef.current = false;
            }
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
  }, [openExistingFolder, t]);

  if (isLoading) {
    return (
      <div
        data-testid="workspace-zero-project-loading"
        className="workspace-welcome flex h-full w-full items-center justify-center p-6"
      >
        <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{t('app:welcomePage.loadingProjects')}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="workspace-zero-project-stage"
      className="workspace-welcome relative flex h-full w-full items-center justify-center overflow-auto p-6"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'open-folder',
            label: t('common:contextMenu.openFolder'),
            onSelect: () => {
              void handleOpenFolder();
            },
          },
          {
            id: 'new-project',
            label: t('common:contextMenu.newProject'),
            onSelect: () => {
              void handleCreateProject();
            },
          },
          {
            id: 'clone-repo',
            label: t('common:contextMenu.cloneRepo'),
            onSelect: () => {
              void handleCloneRepo();
            },
          },
        ]);
      }}
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

      <div className="w-full max-w-lg">
        <div className="mb-8 flex items-center gap-3.5">
          <Logo showText={false} size="hero" className="-ml-2 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {APP_NAME} · {t('app:welcomePage.tagline')}
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
              {t(
                'projectSwitcher.zeroStageTitle',
                '导入或创建一个项目开始协作'
              )}
            </h1>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {t(
                'projectSwitcher.zeroStageSubtitle',
                '打开现有代码目录、创建新项目或克隆远端仓库，也可直接将文件夹拖入当前窗口。'
              )}
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          <ZeroStageActionRow
            icon={FolderOpen}
            primary
            title={t('app:welcomePage.selectFolder')}
            description={t(
              'projectSwitcher.openFolderDesc',
              '导入本地已有代码目录或工作文件夹'
            )}
            onClick={() => void handleOpenFolder()}
            guideId="welcome-select-folder"
            testId="zero-project-open-folder"
          />

          <ZeroStageActionRow
            icon={Plus}
            title={t('app:welcomePage.createNewProject')}
            description={t(
              'projectSwitcher.createProjectDesc',
              '初始化一个新的本地项目目录'
            )}
            onClick={() => void handleCreateProject()}
            guideId="welcome-create-project"
            testId="zero-project-create-project"
          />

          <ZeroStageActionRow
            icon={GitBranch}
            title={t('app:welcomePage.cloneRepo')}
            description={t(
              'projectSwitcher.cloneRepoDesc',
              '从 Git 远端地址克隆仓库并打开'
            )}
            onClick={() => void handleCloneRepo()}
            testId="zero-project-clone-repo"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4 text-xs text-muted-foreground">
          <span>
            {t(
              'projectSwitcher.dropFolderHint',
              '支持将本地项目文件夹直接拖入窗口打开'
            )}
          </span>

          {globalProject ? (
            <button
              type="button"
              data-basic-guide="welcome-global-project"
              data-testid="zero-project-enter-global"
              onClick={() => {
                ensureProjectOpen(globalProject.id);
                switchProject(
                  globalProject.id,
                  paths.projectSessions(globalProject.id)
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t(
                  'projectSwitcher.enterGlobalProject',
                  '进入全局临时空间（无需绑定代码目录）'
                )}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
