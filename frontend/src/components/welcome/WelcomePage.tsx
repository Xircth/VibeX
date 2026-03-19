import { useNavigate } from 'react-router-dom';
import { FolderOpen, Loader2, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useProjects } from '@/hooks/useProjects';
import { useProjectRepos } from '@/hooks';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { APP_NAME, APP_TAGLINE } from '@/lib/branding';
import { Logo } from '@/components/Logo';

function WelcomeSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
      <span>{loading ? '处理中...' : label}</span>
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

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      navigate(`/local-projects/${result.project.id}/tasks`);
    }
  };

  const handleOpenFolder = async () => {
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      navigate(`/local-projects/${result.project.id}/tasks`);
    }
  };

  const handleProjectClick = (projectId: string) => {
    navigate(`/local-projects/${projectId}/tasks`);
  };

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="max-w-2xl mx-auto py-16 px-8">
        <div className="flex items-center gap-3 mb-12">
          <Logo showText={false} />
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {APP_NAME}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{APP_TAGLINE}</p>
          </div>
        </div>

        <WelcomeSection title="开始">
          <WelcomeAction icon={Plus} label="创建新项目" onClick={handleCreateProject} />
          <WelcomeAction icon={FolderOpen} label="选择文件夹" onClick={handleOpenFolder} />
        </WelcomeSection>

        <WelcomeSection title="最近项目">
          {isLoading ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">加载项目中...</div>
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
              />
            ))
          )}
        </WelcomeSection>
      </div>
    </div>
  );
}
