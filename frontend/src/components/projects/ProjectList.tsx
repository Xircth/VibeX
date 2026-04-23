import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { settingsWindowApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Project } from 'shared/types';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { AlertCircle, Loader2, Plus } from 'lucide-react';
import ProjectCard from '@/components/projects/ProjectCard.tsx';
import { useKeyCreate, Scope } from '@/keyboard';
import { useProjects } from '@/hooks/useProjects';

export function ProjectList() {
  const navigate = useNavigate();
  const { projects, isLoading, error: projectsError } = useProjects();
  const [error, setError] = useState('');
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);

  const handleCreateProject = async () => {
    try {
      const result = await ProjectFormDialog.show({});
      if (result.status === 'saved' && result.project) {
        navigate(`/local-projects/${result.project.id}/sessions`);
      }
    } catch {
      // User cancelled - do nothing
    }
  };

  // Semantic keyboard shortcut for creating new project
  useKeyCreate(handleCreateProject, { scope: Scope.PROJECTS });

  const handleEditProject = (_project: Project) => {
    settingsWindowApi.open();
  };

  // Set initial focus when projects are loaded
  useEffect(() => {
    if (projects.length === 0) {
      setFocusedProjectId(null);
      return;
    }

    if (!focusedProjectId || !projects.some((p) => p.id === focusedProjectId)) {
      setFocusedProjectId(projects[0].id);
    }
  }, [projects, focusedProjectId]);

  return (
    <div className="space-y-6 p-8 pb-16 md:pb-8 h-full overflow-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{'项目'}</h1>
          <p className="text-muted-foreground">{'管理您的项目并跟踪其进度'}</p>
        </div>
        <Button onClick={handleCreateProject}>
          <Plus className="mr-2 h-4 w-4" />
          {'创建项目'}
        </Button>
      </div>

      {(error || projectsError) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || projectsError?.message || '获取项目失败'}
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {'加载项目中...'}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
              <Plus className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">{'还没有项目'}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {'通过创建您的第一个项目开始。'}
            </p>
            <Button className="mt-4" onClick={handleCreateProject}>
              <Plus className="mr-2 h-4 w-4" />
              {'创建您的第一个项目'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              isFocused={focusedProjectId === project.id}
              setError={setError}
              onEdit={handleEditProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
