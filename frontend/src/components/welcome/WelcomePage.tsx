import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Loader2, Plus, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useProjects } from '@/hooks/useProjects';
import { useProjectRepos } from '@/hooks';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { APP_NAME, APP_TAGLINE } from '@/lib/branding';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { projectsApi, settingsWindowApi } from '@/lib/api';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
  PROJECT_DELETE_TOAST_OPTIONS,
} from '@/lib/projectDeleteUi';
import { ProjectRailToggleButton } from '@/components/layout/ProjectRailToggleButton';
import { toast } from 'sonner';

function WelcomeSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function WelcomeAction({
  icon: Icon,
  label,
  onClick,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="group flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      )}
      <span>{loading ? '处理中...' : label}</span>
    </button>
  );
}

function RecentProjectItem({
  project,
  onClick,
  onContextMenu,
}: {
  project: { id: string; name: string };
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { data: repos } = useProjectRepos(project.id);
  const repoPath = repos?.[0]?.path ?? '';

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="group flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
      title="左键打开项目，右键显示打开和删除操作"
    >
      <span className="truncate font-medium text-foreground transition-colors">
        {project.name}
      </span>
      {repoPath ? (
        <span className="flex-1 truncate text-right text-xs text-muted-foreground">
          {repoPath}
        </span>
      ) : null}
    </button>
  );
}

type ProjectContextMenuState = {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
};

export function WelcomePage() {
  const navigate = useNavigate();
  const { projects, isLoading } = useProjects();
  const [contextMenu, setContextMenu] =
    useState<ProjectContextMenuState | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);

  const contextMenuStyle = useMemo(() => {
    if (!contextMenu || typeof window === 'undefined') {
      return null;
    }

    return {
      left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 220)),
      top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 120)),
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('blur', closeMenu);

    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, [contextMenu]);

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      navigate(`/local-projects/${result.project.id}/sessions`);
    }
  };

  const handleOpenFolder = async () => {
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      navigate(`/local-projects/${result.project.id}/sessions`);
    }
  };

  const handleProjectClick = useCallback(
    (projectId: string) => {
      navigate(`/local-projects/${projectId}/sessions`);
    },
    [navigate]
  );

  const handleProjectContextMenu = useCallback(
    (
      project: { id: string; name: string },
      event: React.MouseEvent<HTMLButtonElement>
    ) => {
      event.preventDefault();
      setContextMenu({
        projectId: project.id,
        projectName: project.name,
        x: event.clientX,
        y: event.clientY,
      });
    },
    []
  );

  const handleOpenFromContextMenu = useCallback(() => {
    if (!contextMenu) {
      return;
    }

    handleProjectClick(contextMenu.projectId);
    setContextMenu(null);
  }, [contextMenu, handleProjectClick]);

  const handleDeleteFromContextMenu = useCallback(async () => {
    if (!contextMenu || isDeletingProject) {
      return;
    }

    const targetProject = {
      id: contextMenu.projectId,
      name: contextMenu.projectName,
    };
    setContextMenu(null);

    const result = await ConfirmDialog.show({
      title: `删除项目“${targetProject.name}”？`,
      message: '删除项目将移除该项目下的所有会话与工作区数据，此操作不可撤销。',
      confirmText: '确认删除',
      cancelText: '取消',
      variant: 'destructive',
      contentClassName: PROJECT_DELETE_CONFIRM_CLASSNAME,
      contentStyle: PROJECT_DELETE_CONFIRM_STYLE,
    });

    if (result !== 'confirmed') {
      return;
    }

    setIsDeletingProject(true);
    try {
      await projectsApi.delete(targetProject.id);
      toast.success(
        `已删除项目“${targetProject.name}”`,
        PROJECT_DELETE_TOAST_OPTIONS
      );
    } catch (error) {
      console.error('Failed to delete recent project:', error);
      toast.error('删除项目失败', PROJECT_DELETE_TOAST_OPTIONS);
    } finally {
      setIsDeletingProject(false);
    }
  }, [contextMenu, isDeletingProject]);

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-2xl px-8 py-16">
        <div className="mb-12 flex items-start justify-between gap-4">
          <div className="-ml-3 flex items-center gap-3">
            <Logo
              showText={false}
              size="hero"
              className="-ml-4 translate-y-2"
            />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {APP_NAME}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {APP_TAGLINE}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ProjectRailToggleButton />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => settingsWindowApi.open()}
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <WelcomeSection title="开始">
          <WelcomeAction
            icon={Plus}
            label="创建新项目"
            onClick={handleCreateProject}
          />
          <WelcomeAction
            icon={FolderOpen}
            label="选择文件夹"
            onClick={handleOpenFolder}
          />
        </WelcomeSection>

        <WelcomeSection title="最近项目">
          {isLoading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              加载项目中...
            </div>
          ) : projects.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              暂无项目，创建一个开始使用吧。
            </div>
          ) : (
            projects.map((project) => (
              <RecentProjectItem
                key={project.id}
                project={project}
                onClick={() => handleProjectClick(project.id)}
                onContextMenu={(event) =>
                  handleProjectContextMenu(project, event)
                }
              />
            ))
          )}
        </WelcomeSection>
      </div>

      {contextMenu && contextMenuStyle ? (
        <div
          className="fixed z-[1000] min-w-[180px] rounded-xl border border-border/70 bg-background/96 p-1 shadow-2xl backdrop-blur-md"
          style={contextMenuStyle}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted/70"
            onClick={handleOpenFromContextMenu}
          >
            打开
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handleDeleteFromContextMenu()}
            disabled={isDeletingProject}
          >
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}
