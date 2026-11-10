import { useTranslation } from 'react-i18next';
import { BriefcaseBusiness, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import { importedProjectName } from '@/lib/importedProject';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { cn } from '@/lib/utils';

type ProjectRailToggleButtonProps = {
  variant?: 'icon' | 'capsule';
};

export function ProjectRailToggleButton({
  variant = 'icon',
}: ProjectRailToggleButtonProps) {
  const { t } = useTranslation(['panels', 'common', 'app']);
  const { project } = useProject();
  const { projects } = useProjects();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const label = railVisible ? t('railToggle.hide') : t('railToggle.show');
  const projectCount = projects.length;
  const activeProjectName = project
    ? importedProjectName(project, (key) => t(key, { ns: 'app' }))
    : null;

  if (variant === 'capsule') {
    return (
      <button
        type="button"
        onClick={() => {
          setRailVisible(!railVisible);
        }}
        data-project-rail-toggle="true"
        data-testid="bottom-left-project-selector"
        aria-label={label}
        aria-pressed={railVisible}
        title={label}
        className={cn(
          'workspace-toolbar-button flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          'hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          railVisible && 'bg-foreground/[0.08]'
        )}
      >
        <BriefcaseBusiness
          className="h-3.5 w-3.5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <span className="max-w-36 truncate">
          {activeProjectName ?? t('railToggle.show', 'Select Project')}
        </span>
        <span className="rounded bg-foreground/[0.07] px-1 text-[10px] tabular-nums opacity-75">
          {projectCount}
        </span>
        <ChevronUp
          className={cn(
            'h-3 w-3 shrink-0 opacity-60 transition-transform',
            railVisible && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => {
        setRailVisible(!railVisible);
      }}
      data-project-rail-toggle="true"
      aria-label={label}
      aria-pressed={railVisible}
      title={label}
    >
      <BriefcaseBusiness className="h-4 w-4" />
    </Button>
  );
}
