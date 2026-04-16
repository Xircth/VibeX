import { BriefcaseBusiness } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { desktopApi } from '@/lib/api';
import { useProjects } from '@/hooks/useProjects';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

export function ProjectRailToggleButton() {
  const { projects } = useProjects();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => {
        const nextVisible = !railVisible;
        setRailVisible(nextVisible);
        void desktopApi
          .setProjectRailWindowVisible(nextVisible, projects.length)
          .catch((error) => {
            console.error('Failed to toggle project rail window:', error);
            setRailVisible(!nextVisible);
          });
      }}
      data-project-rail-toggle="true"
      aria-label={railVisible ? '隐藏项目栏' : '显示项目栏'}
      title={railVisible ? '隐藏项目栏' : '显示项目栏'}
    >
      <BriefcaseBusiness className="h-4 w-4" />
    </Button>
  );
}
