import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Loader2 } from 'lucide-react';
import { useProjects } from '@/hooks/useProjects';
import { useProjectRepos } from '@/hooks';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { projectsApi, repoApi } from '@/lib/api';
import { APP_NAME, APP_TAGLINE } from '@/lib/branding';
import { Logo } from '@/components/Logo';
import type { LucideIcon } from 'lucide-react';

function WelcomeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
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
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded text-sm text-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-left group disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 text-muted-foreground animate-spin shrink-0" />
      ) : (
        <Icon className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
      )}
      <span>{loading ? '正在打开...' : label}</span>
    </button>
  );
}

function RecentProjectItem({
  project,
  onClick,
}: {
  project: { id: string; name: string };
  onClick: () => void;
}) {
  const { data: repos } = useProjectRepos(project.id);
  const repoPath = repos?.[0]?.path ?? '';

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-2 py-1.5 rounded text-sm hover:bg-muted/60 transition-colors text-left group"
    >
      <span className="font-medium text-foreground transition-colors truncate">
        {project.name}
      </span>
      {repoPath && (
        <span className="text-xs text-muted-foreground truncate flex-1 text-right">
          {repoPath}
        </span>
      )}
    </button>
  );
}

export function WelcomePage() {
  const navigate = useNavigate();
  const { projects, isLoading } = useProjects();
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      navigate(`/local-projects/${result.project.id}/tasks`);
    }
  };

  const handleOpenFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== 'string') return;

      setIsOpeningFolder(true);
      try {
        // Register the selected directory as a git repository
        const repo = await repoApi.register({ path: selected });
        // Use the repo name as the project name
        const projectName = repo.display_name || repo.name;
        // Create the project with this repository
        const project = await projectsApi.create({
          name: projectName,
          repositories: [{ display_name: projectName, git_repo_path: repo.path }],
        });
        navigate(`/local-projects/${project.id}/tasks`);
      } catch {
        // If auto-creation fails (e.g. not a git repo), fall back to the full dialog
        setIsOpeningFolder(false);
        const result = await ProjectFormDialog.show({});
        if (result?.status === 'saved' && result.project) {
          navigate(`/local-projects/${result.project.id}/tasks`);
        }
      } finally {
        setIsOpeningFolder(false);
      }
    } catch {
      // User cancelled dialog or not in Tauri environment
    }
  };

  const handleProjectClick = (projectId: string) => {
    navigate(`/local-projects/${projectId}/tasks`);
  };

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="max-w-2xl mx-auto py-16 px-8">
        {/* Logo/Title */}
        <div className="flex items-center gap-3 mb-12">
          <Logo showText={false} />
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {APP_NAME}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{APP_TAGLINE}</p>
          </div>
        </div>

        {/* Start section */}
        <WelcomeSection title="开始">
          <WelcomeAction icon={Plus} label="创建新项目" onClick={handleCreateProject} />
          <WelcomeAction
            icon={FolderOpen}
            label="打开文件夹"
            onClick={handleOpenFolder}
            loading={isOpeningFolder}
          />
        </WelcomeSection>

        {/* Recent Projects section */}
        <WelcomeSection title="最近的项目">
          {isLoading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">加载项目中...</div>
          ) : projects.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              暂无项目，创建一个开始使用吧。
            </div>
          ) : (
            projects.map((p) => (
              <RecentProjectItem
                key={p.id}
                project={p}
                onClick={() => handleProjectClick(p.id)}
              />
            ))
          )}
        </WelcomeSection>
      </div>
    </div>
  );
}
