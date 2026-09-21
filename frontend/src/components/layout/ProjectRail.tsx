import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, GitBranch, Plus, Trash2, X } from 'lucide-react';
import { HostGlass } from '@/components/ui/host-glass';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { projectsApi } from '@/lib/api';
import { initProjectGitWithPrompt } from '@/lib/initProjectGit';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { toast } from '@/components/ui/toast';
import { useAppContextMenu } from '@/components/context-menu';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
import {
  buildProjectRailTree,
  capProjectRailVisibleCount,
  projectRailPanelHeight,
} from '@/components/layout/projectRailProjects';
import {
  clampProjectRailPosition,
  defaultProjectRailPosition,
  PROJECT_RAIL_WIDTH,
  projectRailHoverPopoverPosition,
  readViewportSize,
  type ProjectRailPosition,
} from '@/components/layout/projectRailPosition';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
} from '@/lib/projectDeleteUi';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { importedProjectName } from '@/lib/importedProject';

const STATIC_GLASS_POINTER = { x: 0, y: 0 };

export function ProjectRail({
  mouseContainerRef,
}: {
  mouseContainerRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation(['panels', 'common', 'app']);
  const { openSurfaceMenu } = useAppContextMenu();
  const { projects, isLoading: isProjectsLoading } = useProjects();
  const { projectId } = useProject();
  const switchProject = useProjectSwitcher();
  const railVisible = useWindowProjectsStore((state) => state.railVisible);
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
  const storedRailPosition = useWindowProjectsStore(
    (state) => state.railPosition
  );
  const setRailPosition = useWindowProjectsStore(
    (state) => state.setRailPosition
  );
  const [hoveredProjectState, setHoveredProjectState] = useState<{
    projectId: string;
    top: number;
    left: number;
  } | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const glassStageRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const [isMovingRail, setIsMovingRail] = useState(false);
  const [viewport, setViewport] = useState(readViewportSize);
  const [dragPosition, setDragPosition] = useState<ProjectRailPosition | null>(
    null
  );
  const moveStateRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startClientX: number;
    startClientY: number;
  } | null>(null);
  const projectRailItemCount = capProjectRailVisibleCount(projects.length);
  const projectRailHeight = projectRailPanelHeight(projectRailItemCount);
  const railPosition = useMemo(() => {
    const fallback = defaultProjectRailPosition(
      PROJECT_RAIL_WIDTH,
      projectRailHeight,
      viewport.width,
      viewport.height
    );
    const base = dragPosition ?? storedRailPosition ?? fallback;
    return clampProjectRailPosition(
      base.x,
      base.y,
      PROJECT_RAIL_WIDTH,
      projectRailHeight,
      viewport.width,
      viewport.height
    );
  }, [
    dragPosition,
    projectRailHeight,
    storedRailPosition,
    viewport.height,
    viewport.width,
  ]);

  const visibleProjects = useMemo(
    () => buildProjectRailTree(projects),
    [projects]
  );

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

  useLayoutEffect(() => {
    const syncViewport = () => {
      setViewport(readViewportSize());
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    if (!isMovingRail) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const move = moveStateRef.current;
      if (!move || move.pointerId !== event.pointerId) {
        return;
      }

      setDragPosition(
        clampProjectRailPosition(
          move.originX + event.clientX - move.startClientX,
          move.originY + event.clientY - move.startClientY,
          PROJECT_RAIL_WIDTH,
          projectRailHeight,
          window.innerWidth,
          window.innerHeight
        )
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      const move = moveStateRef.current;
      if (!move || move.pointerId !== event.pointerId) {
        return;
      }

      const next = clampProjectRailPosition(
        move.originX + event.clientX - move.startClientX,
        move.originY + event.clientY - move.startClientY,
        PROJECT_RAIL_WIDTH,
        projectRailHeight,
        window.innerWidth,
        window.innerHeight
      );
      setRailPosition(next);
      setDragPosition(null);
      moveStateRef.current = null;
      setIsMovingRail(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isMovingRail, projectRailHeight, setRailPosition]);

  useEffect(() => {
    if (!storedRailPosition) {
      return;
    }
    const next = clampProjectRailPosition(
      storedRailPosition.x,
      storedRailPosition.y,
      PROJECT_RAIL_WIDTH,
      projectRailHeight,
      viewport.width,
      viewport.height
    );
    if (
      next.x !== storedRailPosition.x ||
      next.y !== storedRailPosition.y
    ) {
      setRailPosition(next);
    }
  }, [
    projectRailHeight,
    setRailPosition,
    storedRailPosition,
    viewport.height,
    viewport.width,
  ]);

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

  const handleMovePointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest('button')) {
      return;
    }

    moveStateRef.current = {
      pointerId: event.pointerId,
      originX: railPosition.x,
      originY: railPosition.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    setIsMovingRail(true);
  };

  const handleProjectClick = (nextProjectId: string) => {
    if (isMovingRail) {
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
      hoverTimerRef.current = null;
    }

    const itemRect = event.currentTarget.getBoundingClientRect();
    const railRect = railRef.current?.getBoundingClientRect();
    const next = {
      projectId: nextProjectId,
      ...projectRailHoverPopoverPosition(
        itemRect,
        railRect,
        readViewportSize()
      ),
    };
    setHoveredProjectState((current) =>
      current?.projectId === next.projectId &&
      current.top === next.top &&
      current.left === next.left
        ? current
        : next
    );
  };

  const handleProjectMouseLeave = (nextProjectId: string) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    hoverTimerRef.current = setTimeout(() => {
      setHoveredProjectState((current) =>
        current?.projectId === nextProjectId ? null : current
      );
      hoverTimerRef.current = null;
    }, 160);
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
      confirmText: t('projectRail.removeAction'),
      cancelText: t('common:cancel'),
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

  const hoveredProject = hoveredProjectState
    ? visibleProjects.find(
        (project) => project.id === hoveredProjectState.projectId
      )
    : undefined;

  if (!railVisible) {
    return null;
  }

  const shell = (
    <div
      ref={railRef}
      className={cn(
        'project-rail-shell project-rail-shell--inline',
        isMovingRail && 'is-moving'
      )}
      onPointerDown={handleMovePointerDown}
    >
      <div className="project-rail-header">
        <span className="project-rail-title">{t('projectRail.title')}</span>
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

      <div
        className="project-rail-projects"
        onContextMenu={(event) => {
          openSurfaceMenu(event, [
            {
              id: 'open-folder',
              label: t('common:contextMenu.openFolder'),
              onSelect: () => {
                void handleOpenProject();
              },
            },
            {
              id: 'new-project',
              label: t('common:contextMenu.newProject'),
              onSelect: () => {
                void handleCreateProject();
              },
            },
          ]);
        }}

      >
        {visibleProjects.map((project) => {
          const isActive = project.id === projectId;
          const snapshot = projectSnapshots[project.id];
          const visualState = snapshot
            ? deriveProjectVisualState(snapshot, projectAlerts[project.id])
            : 'idle';
          const meta = resolveProjectVisualStateMeta(visualState);
          return (
            <div
              key={project.id}
              className="project-rail-project-slot group"
              style={{ paddingLeft: `${project.depth * 14}px` }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/project-id', project.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                const sourceId = event.dataTransfer.types.includes(
                  'text/project-id'
                );
                if (!sourceId) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData('text/project-id');
                if (!sourceId || sourceId === project.id) return;
                const source = visibleProjects.find(
                  (item) => item.id === sourceId
                );
                const parentPath = project.root_path;
                const childPath = source?.root_path;
                if (!parentPath || !childPath) return;
                const parent = parentPath.replace(/\\/g, '/').replace(/\/$/, '');
                const child = childPath.replace(/\\/g, '/').replace(/\/$/, '');
                if (!child.startsWith(`${parent}/`)) return;
                void projectsApi.setParent(sourceId, project.id).catch(() => {
                  toast.error(t('projectRail.deleteFailed'));
                });
              }}
              onMouseEnter={(event) =>
                handleProjectMouseEnter(project.id, event)
              }
              onMouseLeave={() => handleProjectMouseLeave(project.id)}
            >
              <button
                type="button"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={() => handleProjectClick(project.id)}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  openSurfaceMenu(event, [
                    {
                      id: 'open',
                      label: t('common:contextMenu.open'),
                      onSelect: () => handleProjectClick(project.id),
                    },
                    ...(!project.is_git && !project.is_home
                      ? [
                          {
                            id: 'init-git',
                            label: t('projectRail.initGit'),
                            onSelect: () => {
                              void initProjectGitWithPrompt(project);
                            },
                          },
                        ]
                      : []),
                    ...(!project.is_home
                      ? [
                          {
                            id: 'delete',
                            label: t('projectRail.removeAction'),
                            danger: false,
                            onSelect: () => {
                              void handleDeleteProject({
                                id: project.id,
                                name: importedProjectName(project, (key) =>
                                  t(key, { ns: 'app' })
                                ),
                              });
                            },
                          },
                        ]
                      : []),
                  ]);
                }}
                aria-label={`${importedProjectName(project, (key) => t(key, { ns: 'app' }))}: ${meta.label}`}
                className={cn(
                  'project-rail-project-button',
                  isActive && 'is-active'
                )}
              >
                {project.is_git ? (
                  <GitBranch
                    className="project-rail-project-icon"
                    aria-hidden="true"
                  />
                ) : (
                  <FolderOpen
                    className="project-rail-project-icon"
                    aria-hidden="true"
                  />
                )}
                <span className="project-rail-project-name">
                  {importedProjectName(project, (key) =>
                    t(key, { ns: 'app' })
                  )}
                </span>
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

              {project.is_home ? null : (
              <button
                type="button"
                className="project-rail-delete-button"
                onPointerDown={(event) => {
                  event.stopPropagation();
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
              )}

            </div>
          );
        })}
        {visibleProjects.length === 0 && !isProjectsLoading ? (
          <div className="project-rail-empty-state">
            {t('projectRail.emptyState')}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
    <div
      className="project-rail-inline-host"
      style={{
        position: 'fixed',
        left: railPosition.x,
        top: railPosition.y,
      }}
    >
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
    {hoveredProject && hoveredProjectState ? (
      <ProjectRecentSessionsPopover
        projectName={importedProjectName(hoveredProject, (key) =>
          t(key, { ns: 'app' })
        )}
        recentSessions={
          projectSnapshots[hoveredProject.id]?.recentSessions ?? []
        }
        align="right"
        style={{
          top: hoveredProjectState.top,
          left: hoveredProjectState.left,
        }}
      />
    ) : null}
    </>
  );
}
