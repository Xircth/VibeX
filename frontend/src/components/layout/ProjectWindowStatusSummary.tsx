import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { cn } from '@/lib/utils';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';

const BOTTOM_STATUS_LIMIT = 6;

export function ProjectWindowStatusSummary() {
  const { projectId: currentProjectId } = useProject();
  const { projectsById } = useProjects();
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);

  const statusItems = useMemo(() => {
    const candidateProjectIds = Array.from(
      new Set([
        ...Object.keys(projectSnapshots),
        ...openProjectIds,
        ...(currentProjectId ? [currentProjectId] : []),
      ])
    ).slice(0, BOTTOM_STATUS_LIMIT);

    return candidateProjectIds
      .map((projectId) => {
        const snapshot = projectSnapshots[projectId];
        if (!snapshot) {
          return null;
        }

        return {
          projectId,
          projectName: projectsById[projectId]?.name ?? '项目',
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

  if (railVisible || statusItems.length === 0) {
    return null;
  }

  return (
    <div className="relative flex items-center gap-2">
      {statusItems.map((item) => {
        const meta = resolveProjectVisualStateMeta(item.visualState);
        const isHovered = hoveredProjectId === item.projectId;

        return (
          <div
            key={item.projectId}
            className="relative"
            onMouseEnter={() => setHoveredProjectId(item.projectId)}
            onMouseLeave={() =>
              setHoveredProjectId((current) =>
                current === item.projectId ? null : current
              )
            }
          >
            <div
              className="flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5"
              title={`${item.projectName}: ${meta.label}`}
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
            </div>

            {isHovered ? (
              <ProjectRecentSessionsPopover
                projectName={item.projectName}
                recentSessions={item.recentSessions}
                align="top"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
