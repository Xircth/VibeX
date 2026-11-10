import { useTranslation } from 'react-i18next';
import { BriefcaseBusiness, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  deriveProjectVisualState,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
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
  const { project, projectId } = useProject();
  const { projects, projectsById } = useProjects();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);

  const label = railVisible ? t('railToggle.hide') : t('railToggle.show');
  const projectCount = projects.length;
  const resolvedProject =
    project ?? (projectId ? projectsById?.[projectId] : undefined);
  const resolvedProjectId = resolvedProject?.id ?? projectId;
  const activeProjectName = resolvedProject
    ? importedProjectName(resolvedProject, (key) => t(key, { ns: 'app' }))
    : null;
  const activeSnapshot = resolvedProjectId
    ? projectSnapshots[resolvedProjectId]
    : undefined;
  const visualState =
    resolvedProjectId && activeSnapshot
      ? deriveProjectVisualState(
          activeSnapshot,
          projectAlerts[resolvedProjectId]
        )
      : 'idle';
  const statusMeta = resolveProjectVisualStateMeta(visualState);

  if (variant === 'capsule') {
    return (
      <div className="relative flex w-full items-center">
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
            'workspace-toolbar-button flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-border/50 bg-foreground/[0.04] px-2.5 text-xs font-medium transition-colors',
            'hover:bg-foreground/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            railVisible && 'border-border bg-foreground/[0.1]'
          )}
        >
          <BriefcaseBusiness
            className="h-3.5 w-3.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeProjectName ?? t('railToggle.show', 'Select Project')}
          </span>
          {resolvedProjectId ? (
            visualState === 'loading' ? (
              <Loader2
                data-testid="project-selector-status-spinner"
                className="h-3 w-3 shrink-0 animate-spin text-primary"
              />
            ) : (
              <span
                data-testid="project-selector-status-dot"
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  statusMeta.dotClassName,
                  statusMeta.pulseClassName
                )}
              />
            )
          ) : null}
          <span className="rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] tabular-nums opacity-75">
            {projectCount}
          </span>
          <ChevronUp
            className={cn(
              'h-3.5 w-3.5 shrink-0 opacity-60 transition-transform',
              railVisible && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </button>
      </div>
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
