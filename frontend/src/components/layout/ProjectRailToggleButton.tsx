import { useTranslation } from 'react-i18next';
import { BriefcaseBusiness } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/useProjects';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { cn } from '@/lib/utils';

type ProjectRailToggleButtonProps = {
  variant?: 'icon' | 'capsule';
};

export function ProjectRailToggleButton({
  variant = 'icon',
}: ProjectRailToggleButtonProps) {
  const { t } = useTranslation(['panels', 'common']);
  const { projects } = useProjects();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const label = railVisible ? t('railToggle.hide') : t('railToggle.show');
  const projectCount = projects.length;

  if (variant === 'capsule') {
    return (
      <button
        type="button"
        onClick={() => {
          setRailVisible(!railVisible);
        }}
        data-project-rail-toggle="true"
        aria-label={label}
        aria-pressed={railVisible}
        title={label}
        className={cn(
          'flex shrink-0 cursor-pointer items-center gap-1 rounded-full',
          'border border-border/70 bg-background/70 px-2 py-0.5 text-left',
          'transition-colors hover:border-border hover:bg-background',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          railVisible && 'border-border bg-background'
        )}
      >
        <BriefcaseBusiness className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="text-[10px] tabular-nums opacity-90">
          {projectCount}
        </span>
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
