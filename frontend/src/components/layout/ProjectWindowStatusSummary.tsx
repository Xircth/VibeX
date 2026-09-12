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

const BOTTOM_STATUS_LIMIT = 6;

export function ProjectWindowStatusSummary() {
  const { t } = useTranslation('statusbar');
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
    const existingProjectIds = new Set(Object.keys(projectsById));
    const candidateProjectIds = Array.from(
      new Set([
        ...Object.keys(projectSnapshots),
        ...openProjectIds,
        ...(currentProjectId ? [currentProjectId] : []),
      ])
    )
      .filter((projectId) => existingProjectIds.has(projectId))
      .slice(0, BOTTOM_STATUS_LIMIT);

    return candidateProjectIds
      .map((projectId) => {
        const project = projectsById[projectId];
        const snapshot = projectSnapshots[projectId];
        if (!project || !snapshot) {
          return null;
        }

        return {
          projectId,
          projectName: project.name,
          visualState: deriveProjectVisualState(
            snapshot,
            projectAlerts[projectId]
          ),
          recentSessions: snapshot.recentSessions,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [
    currentProjectId,
    openProjectIds,
    projectAlerts,
    projectSnapshots,
    projectsById,
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

  if (railVisible || statusItems.length === 0) {
    return null;
  }

  return (
    <div className="relative z-20 flex items-center gap-2 overflow-visible">
      {statusItems.map((item) => {
        const meta = resolveProjectVisualStateMeta(item.visualState);
        const isCurrent = item.projectId === currentProjectId;
        const isHovered = hoveredProjectState?.projectId === item.projectId;

        return (
          <div key={item.projectId} className="relative">
            <button
              type="button"
              aria-current={isCurrent ? 'page' : undefined}
              aria-label={t('openProject', { name: item.projectName })}
              title={`${item.projectName}: ${meta.label}`}
              onClick={() => handleProjectClick(item.projectId)}
              onMouseEnter={(event) =>
                handleProjectMouseEnter(item.projectId, event)
              }
              onMouseLeave={() => handleProjectMouseLeave(item.projectId)}
              className={cn(
                'flex cursor-pointer items-center gap-1 rounded-full',
                'border border-border/70 bg-background/70 px-2 py-0.5 text-left',
                'transition-colors hover:border-border hover:bg-background',
                'focus-visible:outline-none focus-visible:ring-1',
                'focus-visible:ring-ring',
                isCurrent && 'border-border bg-background'
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
              <span className="max-w-24 truncate text-[10px] opacity-90">
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
