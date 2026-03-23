import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { cn } from '@/lib/utils';
import { paths } from '@/lib/paths';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';

const PROJECT_LIST_LIMIT = 8;

export function ProjectRail() {
  const { projects } = useProjects();
  const { projectId } = useProject();
  const switchProject = useProjectSwitcher();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const openProjectIds = useWindowProjectsStore((state) => state.openProjectIds);
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const setRailVisible = useWindowProjectsStore((state) => state.setRailVisible);
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const projectListRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    didDrag: boolean;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const visibleProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const orderedIds = Array.from(
      new Set([
        ...(projectId ? [projectId] : []),
        ...openProjectIds,
        ...projects.map((project) => project.id),
      ])
    ).slice(0, PROJECT_LIST_LIMIT);

    return orderedIds
      .map((id) => byId.get(id))
      .filter((project): project is NonNullable<typeof project> =>
        Boolean(project)
      );
  }, [openProjectIds, projectId, projects]);

  useEffect(() => {
    if (!railVisible) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (railRef.current?.contains(target)) {
        return;
      }

      if (target.closest('[data-project-rail-toggle="true"]')) {
        return;
      }

      setRailVisible(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [railVisible, setRailVisible]);

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(result.project.id, paths.projectTasks(result.project.id));
    }
  };

  const handleOpenProject = async () => {
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(result.project.id, paths.projectTasks(result.project.id));
    }
  };

  const handleProjectListWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = projectListRef.current;
    if (!container) {
      return;
    }

    event.preventDefault();
    container.scrollTop += event.deltaY;
  };

  const handleProjectListPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) {
      dragStateRef.current = null;
      return;
    }

    const container = projectListRef.current;
    if (!container) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: container.scrollTop,
      didDrag: false,
    };
    setIsDragging(true);
    container.setPointerCapture(event.pointerId);
  };

  const handleProjectListPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    const container = projectListRef.current;
    const dragState = dragStateRef.current;
    if (!container || !dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaY = event.clientY - dragState.startY;
    if (Math.abs(deltaY) > 4) {
      dragState.didDrag = true;
    }

    container.scrollTop = dragState.startScrollTop - deltaY;
  };

  const endProjectListDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = projectListRef.current;
    const dragState = dragStateRef.current;
    if (!container || !dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    window.setTimeout(() => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
      }
    }, 0);
    setIsDragging(false);
  };

  const handleProjectClick = (nextProjectId: string) => {
    if (dragStateRef.current?.didDrag) {
      dragStateRef.current = null;
      return;
    }

    switchProject(nextProjectId);
  };

  if (!railVisible) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed left-3 top-1/2 z-40 -translate-y-1/2">
      <div
        ref={railRef}
        className="project-rail-panel pointer-events-auto relative flex w-[84px] flex-col items-center gap-3 rounded-[30px] border px-2.5 py-3.5"
      >
        <div className="project-rail-orb" aria-hidden="true" />
        <div className="project-rail-header">
          <span className="project-rail-header-dot" />
          <span className="project-rail-header-text">Projects</span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="project-rail-action h-11 w-11 rounded-[18px]"
          onClick={handleCreateProject}
          aria-label="创建新项目"
          title="创建新项目"
        >
          <Plus className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="project-rail-action h-11 w-11 rounded-[18px]"
          onClick={handleOpenProject}
          aria-label="打开项目"
          title="打开项目"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>

        <div className="project-rail-divider" />

        <div
          ref={projectListRef}
          className={cn(
            'project-rail-scroll flex max-h-[60vh] w-full flex-col items-center gap-2.5 overflow-y-auto pb-1',
            isDragging && 'is-dragging'
          )}
          onWheel={handleProjectListWheel}
          onPointerDown={handleProjectListPointerDown}
          onPointerMove={handleProjectListPointerMove}
          onPointerUp={endProjectListDrag}
          onPointerCancel={endProjectListDrag}
        >
          {visibleProjects.map((project) => {
            const isActive = project.id === projectId;
            const snapshot = projectSnapshots[project.id];
            const visualState = snapshot
              ? deriveProjectVisualState(snapshot, projectAlerts[project.id])
              : 'idle';
            const meta = resolveProjectVisualStateMeta(visualState);
            const isHovered = hoveredProjectId === project.id;

            return (
              <div
                key={project.id}
                className="relative"
                onMouseEnter={() => setHoveredProjectId(project.id)}
                onMouseLeave={() =>
                  setHoveredProjectId((current) =>
                    current === project.id ? null : current
                  )
                }
              >
                <button
                  type="button"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    dragStateRef.current = null;
                  }}
                  onClick={() => handleProjectClick(project.id)}
                  title={`${project.name}: ${meta.label}`}
                  className={cn(
                    'project-rail-project relative flex h-12 w-12 items-center justify-center rounded-[18px] border text-[11px] font-semibold transition-all duration-200',
                    isActive
                      ? 'project-rail-project-active border-primary text-primary-foreground'
                      : 'border-border/70 bg-secondary/60 text-foreground hover:border-primary/40 hover:bg-secondary/90'
                  )}
                >
                  <span className="max-w-[30px] truncate text-[11px] font-bold uppercase tracking-[0.08em]">
                    {Array.from(project.name).slice(0, 2).join('') || '项目'}
                  </span>
                  {visualState === 'loading' ? (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-background bg-background shadow-sm">
                      <span className="h-2 w-2 animate-spin rounded-full border border-primary border-t-transparent" />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border border-background shadow-sm',
                        meta.dotClassName,
                        meta.pulseClassName
                      )}
                    />
                  )}
                </button>

                <div className="pointer-events-none mt-1 max-w-[64px] truncate text-center text-[10px] font-medium text-muted-foreground/90">
                  {project.name}
                </div>

                {isHovered && snapshot ? (
                  <ProjectRecentSessionsPopover
                    projectName={project.name}
                    recentSessions={snapshot.recentSessions}
                    align="right"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
