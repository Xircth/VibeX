import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

export function ProjectRailToggleButton() {
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const toggleRailVisible = useWindowProjectsStore(
    (state) => state.toggleRailVisible
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={toggleRailVisible}
      data-project-rail-toggle="true"
      aria-label={railVisible ? '隐藏项目栏' : '显示项目栏'}
      title={railVisible ? '隐藏项目栏' : '显示项目栏'}
    >
      {railVisible ? (
        <PanelLeftClose className="h-4 w-4" />
      ) : (
        <PanelLeftOpen className="h-4 w-4" />
      )}
    </Button>
  );
}
