import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { HostGlass } from '@/components/ui/host-glass';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { projectsApi } from '@/lib/api';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { toast } from '@/components/ui/toast';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
import {
  buildProjectRailOrderedIds,
  capProjectRailVisibleCount,
} from '@/components/layout/projectRailProjects';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
} from '@/lib/projectDeleteUi';
import { ProjectRailProjectBadge } from '@/components/layout/ProjectRailProjectBadge';
import { useMediaQuery } from '@/hooks/useMediaQuery';

const STATIC_GLASS_POINTER = { x: 0, y: 0 };

export function ProjectRail({
  mouseContainerRef,
}: {
  mouseContainerRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { projects, isLoading: isProjectsLoading } = useProjects();
  const { projectId } = useProject();
  const switchProject = useProjectSwitcher();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const setRailVisible = useWindowProjectsStore(
    (state) => state.setRailVisible
  );
  const [hoveredProjectState, setHoveredProjectState] = useState<{
    projectId: string;
    top: number;
    left: number;
  } | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const projectListRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    didDrag: boolean;
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const glassStageRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const [isDragging, setIsDragging] = useState(false);
  const orderedProjectIds = useMemo(
    () =>
      buildProjectRailOrderedIds({
        openProjectIds,
        currentProjectId: projectId,
        projectSnapshotIds: Object.keys(projectSnapshots),
        projectIds: projects.map((project) => project.id),
      }),
    [openProjectIds, projectId, projectSnapshots, projects]
  );
  const projectRailItemCount = capProjectRailVisibleCount(projects.length);
  const projectRailHeight = 273 + Math.max(0, projectRailItemCount - 4) * 36;

  const visibleProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));

    return orderedProjectIds
      .map((id) => {
        const project = byId.get(id);
        if (project) {
          return {
            id: project.id,
            name: project.name,
          };
        }

        return null;
      })
      .filter((project): project is { id: string; name: string } =>
        Boolean(project)
      );
  }, [orderedProjectIds, projects]);

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

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const handleCreateProject = async () => {
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  };

  const handleOpenProject = async () => {
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  };

  const handleCloseRail = () => {
    setRailVisible(false);
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

  const handleProjectMouseEnter = (
    nextProjectId: string,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    const rect = event.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      setHoveredProjectState({
        projectId: nextProjectId,
        top: rect.top + rect.height / 2,
        left: rect.right + 12,
      });
    }, 500);
  };

  const handleProjectMouseLeave = (nextProjectId: string) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    setHoveredProjectState((current) =>
      current?.projectId === nextProjectId ? null : current
    );
  };

  const handleDeleteProject = async (
    targetProject: { id: string; name: string },
    event?: React.MouseEvent
  ) => {
    event?.preventDefault();
    event?.stopPropagation();

    const result = await ConfirmDialog.show({
      title: t('projectRail.deleteConfirmTitle', { name: targetProject.name }),
      message: t('projectRail.deleteConfirmMessage'),
      confirmText: t('common:delete'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
      contentClassName: PROJECT_DELETE_CONFIRM_CLASSNAME,
      contentStyle: PROJECT_DELETE_CONFIRM_STYLE,
    });

    if (result !== 'confirmed') {
      return;
    }

    try {
      await projectsApi.delete(targetProject.id);
      toast.success(
        t('projectRail.deleteSuccess', { name: targetProject.name })
      );
    } catch (error) {
      console.error('Failed to delete project from project rail:', error);
      toast.error(t('projectRail.deleteFailed'));
    }
  };

  if (!railVisible) {
    return null;
  }

  const shell = (
    <div
      ref={railRef}
      className="project-rail-shell project-rail-shell--inline"
    >
      <div
        ref={projectListRef}
        className={cn('project-rail-projects', isDragging && 'is-dragging')}
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
          const isHovered = hoveredProjectState?.projectId === project.id;

          return (
            <div
              key={project.id}
              className="project-rail-project-slot group"
              onMouseEnter={(event) =>
                handleProjectMouseEnter(project.id, event)
              }
              onMouseLeave={() => handleProjectMouseLeave(project.id)}
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
                  'project-rail-project-button',
                  isActive && 'is-active'
                )}
              >
                <ProjectRailProjectBadge
                  name={project.name || t('projectRail.placeholderProjectName')}
                  active={isActive}
                />
                {visualState === 'loading' ? (
                  <span className="project-rail-status-dot-shell">
                    <span className="project-rail-status-spinner" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      'project-rail-status-dot',
                      meta.dotClassName,
                      meta.pulseClassName
                    )}
                  />
                )}
              </button>

              <button
                type="button"
                className="project-rail-delete-button"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  dragStateRef.current = null;
                }}
                onClick={(event) =>
                  void handleDeleteProject(
                    { id: project.id, name: project.name },
                    event
                  )
                }
                aria-label={t('projectRail.deleteProjectAria', {
                  name: project.name,
                })}
                title={t('projectRail.deleteProjectAria', {
                  name: project.name,
                })}
              >
                <Trash2 aria-hidden="true" />
              </button>

              {isHovered && snapshot ? (
                <ProjectRecentSessionsPopover
                  projectName={project.name}
                  recentSessions={snapshot.recentSessions}
                  align="right"
                  style={{
                    top: hoveredProjectState?.top,
                    left: hoveredProjectState?.left,
                    transform: 'translateY(-50%)',
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {visibleProjects.length === 0 && !isProjectsLoading ? (
          <div className="project-rail-empty-state">
            {t('projectRail.emptyState')}
          </div>
        ) : null}
      </div>

      <div className="project-rail-divider" role="separator" />

      <div className="project-rail-actions">
        <button
          type="button"
          className="project-rail-action-button"
          onClick={handleCreateProject}
          aria-label={t('projectRail.createProjectAria')}
          title={t('projectRail.createProjectAria')}
        >
          <Plus aria-hidden="true" />
        </button>

        <button
          type="button"
          className="project-rail-action-button"
          onClick={handleOpenProject}
          aria-label={t('projectRail.openProjectAria')}
          title={t('projectRail.openProjectAria')}
        >
          <FolderOpen aria-hidden="true" />
        </button>

        <button
          type="button"
          className="project-rail-action-button"
          onClick={handleCloseRail}
          aria-label={t('projectRail.closeRailAria')}
          title={t('projectRail.closeRailAria')}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="project-rail-inline-host">
      <div
        ref={glassStageRef}
        className="project-rail-inline-stage"
        style={{ height: `${projectRailHeight}px` }}
      >
        <HostGlass
          className="project-rail-liquid-glass"
          padding="0"
          cornerRadius={20}
          displacementScale={64}
          blurAmount={0.1}
          saturation={130}
          aberrationIntensity={2}
          elasticity={prefersReducedMotion ? 0 : 0.15}
          mouseContainer={mouseContainerRef ?? glassStageRef}
          globalMousePos={
            prefersReducedMotion ? STATIC_GLASS_POINTER : undefined
          }
          mouseOffset={prefersReducedMotion ? STATIC_GLASS_POINTER : undefined}
          mode="standard"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: '100%',
            height: '100%',
          }}
        >
          {shell}
        </HostGlass>
      </div>
    </div>
  );
}
