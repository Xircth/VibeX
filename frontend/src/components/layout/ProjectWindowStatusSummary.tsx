import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { cn } from '@/lib/utils';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
import { ProjectRailToggleButton } from '@/components/layout/ProjectRailToggleButton';
import { importedProjectName } from '@/lib/importedProject';
import { selectBottomStatusProjectIds } from '@/components/layout/projectRailProjects';

export function ProjectWindowStatusSummary() {
  const { t } = useTranslation(['statusbar', 'app']);
  const { projectId: currentProjectId } = useProject();
  const { projectsById } = useProjects();
  const switchProject = useProjectSwitcher();
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const [hoveredProjectState, setHoveredProjectState] = useState<{
    projectId: string;
    top: number;
    left: number;
  } | null>(null);

  const statusItems = useMemo(() => {
    const candidateProjectIds = selectBottomStatusProjectIds({
      openProjectIds,
      currentProjectId,
      existingProjectIds: Object.keys(projectsById),
    });

    return candidateProjectIds
      .map((projectId) => {
        const project = projectsById[projectId];
        if (!project) {
          return null;
        }

        const snapshot = projectSnapshots[projectId];
        return {
          projectId,
          projectName: importedProjectName(project, (key) =>
            t(key, { ns: 'app' })
          ),
          visualState: snapshot
            ? deriveProjectVisualState(snapshot, projectAlerts[projectId])
            : 'idle',
          recentSessions: snapshot?.recentSessions ?? [],
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [
    currentProjectId,
    openProjectIds,
    projectAlerts,
    projectSnapshots,
    projectsById,
    t,
  ]);

  const handleProjectClick = (projectId: string) => {
    if (projectId === currentProjectId) {
      return;
    }

    switchProject(projectId);
  };

  const handleProjectMouseEnter = (
    projectId: string,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const popoverWidth = 288;
    setHoveredProjectState({
      projectId,
      top: rect.top - 8,
      left: Math.max(
        8,
        Math.min(rect.left, window.innerWidth - popoverWidth - 8)
      ),
    });
  };

  const handleProjectMouseLeave = (projectId: string) => {
    setHoveredProjectState((current) =>
      current?.projectId === projectId ? null : current
    );
  };

  return (
    <div className="relative z-20 flex items-center gap-1.5 overflow-visible">
      <ProjectRailToggleButton variant="capsule" />
      {railVisible
        ? null
        : statusItems
            .filter((item) => item.projectId !== currentProjectId)
            .map((item) => {
              const meta = resolveProjectVisualStateMeta(item.visualState);
              const isCurrent = item.projectId === currentProjectId;
              const isHovered =
                hoveredProjectState?.projectId === item.projectId;

              return (
                <div key={item.projectId} className="relative">
                  <button
                    type="button"
                    aria-current={isCurrent ? 'page' : undefined}
                    aria-label={t('openProject', { name: item.projectName })}
                    onClick={() => handleProjectClick(item.projectId)}
                    onMouseEnter={(event) =>
                      handleProjectMouseEnter(item.projectId, event)
                    }
                    onMouseLeave={() => handleProjectMouseLeave(item.projectId)}
                    className={cn(
                      'flex h-6 cursor-pointer items-center gap-1 rounded-md',
                      'px-2 text-left text-xs transition-colors hover:bg-foreground/[0.06]',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    )}
                  >
                    {item.visualState === 'loading' ? (
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                    ) : (
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          meta.dotClassName,
                          meta.pulseClassName
                        )}
                      />
                    )}
                    <span className="max-w-24 truncate text-[11px] opacity-80">
                      {item.projectName}
                    </span>
                  </button>

                  {isHovered ? (
                    <ProjectRecentSessionsPopover
                      projectName={item.projectName}
                      recentSessions={item.recentSessions}
                      align="top"
                      style={{
                        top: hoveredProjectState?.top,
                        left: hoveredProjectState?.left,
                        transform: 'translateY(-100%)',
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
    </div>
  );
}
