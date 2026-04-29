import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { normalizeProjectRoute, paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { desktopApi, projectsApi } from '@/lib/api';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';

export function ProjectRail({ standalone = false }: { standalone?: boolean }) {
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
  const [isDragging, setIsDragging] = useState(false);
  const [fallbackProjects, setFallbackProjects] = useState<typeof projects>([]);
  const [isResolvingStandaloneProjects, setIsResolvingStandaloneProjects] =
    useState(false);
  const hasStoredProjectSignals = useMemo(
    () =>
      openProjectIds.length > 0 ||
      Object.keys(projectSnapshots).length > 0 ||
      Object.keys(projectAlerts).length > 0,
    [openProjectIds, projectAlerts, projectSnapshots]
  );

  useEffect(() => {
    if (!standalone) {
      return;
    }

    const root = document.getElementById('root');
    const previousDocumentElementBackground =
      document.documentElement.style.background;
    const previousBodyBackground = document.body.style.background;
    const previousBodyMargin = document.body.style.margin;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootBackground = root?.style.background ?? '';
    const previousRootOverflow = root?.style.overflow ?? '';

    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';

    if (root) {
      root.style.background = 'transparent';
      root.style.overflow = 'hidden';
    }

    return () => {
      document.documentElement.style.background =
        previousDocumentElementBackground;
      document.body.style.background = previousBodyBackground;
      document.body.style.margin = previousBodyMargin;
      document.body.style.overflow = previousBodyOverflow;

      if (root) {
        root.style.background = previousRootBackground;
        root.style.overflow = previousRootOverflow;
      }
    };
  }, [standalone]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_EMPTY_RETRIES = 3;
    let emptyRetryCount = 0;

    if (!standalone) {
      setFallbackProjects([]);
      setIsResolvingStandaloneProjects(false);
      return;
    }

    if (projects.length > 0) {
      setFallbackProjects([]);
      setIsResolvingStandaloneProjects(false);
      return;
    }

    const loadProjects = async () => {
      setIsResolvingStandaloneProjects(true);

      try {
        const data = await projectsApi.getAll();
        if (cancelled) {
          return;
        }

        if (data.length > 0 || !hasStoredProjectSignals) {
          setFallbackProjects(data);
          setIsResolvingStandaloneProjects(false);
          return;
        }

        if (emptyRetryCount >= MAX_EMPTY_RETRIES) {
          setFallbackProjects([]);
          setIsResolvingStandaloneProjects(false);
          return;
        }

        emptyRetryCount += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadProjects();
        }, 600);
      } catch (error) {
        console.error(
          'Failed to load projects for project rail window:',
          error
        );
        if (cancelled) {
          return;
        }

        if (emptyRetryCount >= MAX_EMPTY_RETRIES) {
          setFallbackProjects([]);
          setIsResolvingStandaloneProjects(false);
          return;
        }

        emptyRetryCount += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadProjects();
        }, 600);
      }
    };

    void loadProjects();

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [hasStoredProjectSignals, projects, standalone]);

  const effectiveProjects =
    standalone && projects.length === 0 ? fallbackProjects : projects;
  const orderedProjectIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...openProjectIds,
          ...(projectId ? [projectId] : []),
          ...Object.keys(projectSnapshots),
          ...effectiveProjects.map((project) => project.id),
        ])
      ),
    [effectiveProjects, openProjectIds, projectId, projectSnapshots]
  );
  const shouldShowPlaceholderProjects =
    standalone &&
    effectiveProjects.length === 0 &&
    isResolvingStandaloneProjects &&
    hasStoredProjectSignals;
  const projectRailItemCount =
    effectiveProjects.length > 0
      ? effectiveProjects.length
      : shouldShowPlaceholderProjects
        ? orderedProjectIds.length
        : 0;

  useEffect(() => {
    if (!standalone) {
      return;
    }

    void desktopApi
      .syncProjectRailWindowBounds(projectRailItemCount)
      .catch((error) => {
        console.error('Failed to sync standalone project rail size:', error);
      });
  }, [projectRailItemCount, standalone]);

  const visibleProjects = useMemo(() => {
    const byId = new Map(
      effectiveProjects.map((project) => [project.id, project])
    );

    return orderedProjectIds
      .map((id) => {
        const project = byId.get(id);
        if (project) {
          return {
            id: project.id,
            name: project.name,
          };
        }

        if (shouldShowPlaceholderProjects) {
          return {
            id,
            name: '项目',
          };
        }

        return null;
      })
      .filter((project): project is { id: string; name: string } =>
        Boolean(project)
      );
  }, [effectiveProjects, orderedProjectIds, shouldShowPlaceholderProjects]);

  useEffect(() => {
    if (standalone) {
      return;
    }

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
  }, [railVisible, setRailVisible, standalone]);

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
      if (standalone) {
        await desktopApi.activateProjectRailTarget({
          projectId: result.project.id,
          route: paths.projectSessions(result.project.id),
        });
      } else {
        switchProject(
          result.project.id,
          paths.projectSessions(result.project.id)
        );
      }
    }
  };

  const handleOpenProject = async () => {
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      if (standalone) {
        await desktopApi.activateProjectRailTarget({
          projectId: result.project.id,
          route: paths.projectSessions(result.project.id),
        });
      } else {
        switchProject(
          result.project.id,
          paths.projectSessions(result.project.id)
        );
      }
    }
  };

  const handleCloseRail = () => {
    setRailVisible(false);
    void desktopApi.setProjectRailWindowVisible(false).catch((error) => {
      console.error('Failed to close project rail window:', error);
      setRailVisible(true);
    });
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

    if (standalone) {
      const route = normalizeProjectRoute(
        useWindowProjectsStore.getState().lastRouteByProject[nextProjectId] ??
          paths.projectSessions(nextProjectId)
      );
      void desktopApi.activateProjectRailTarget({
        projectId: nextProjectId,
        route,
      });
    } else {
      switchProject(nextProjectId);
    }
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

  if (!standalone && !railVisible) {
    return null;
  }

  const shell = (
    <div
      ref={railRef}
      className={
        standalone
          ? 'project-rail-shell pointer-events-auto grid h-full w-full grid-rows-[minmax(0,1fr)_auto_auto] overflow-hidden rounded-[18px] bg-background/72 px-1 py-3 shadow-xl backdrop-blur-xl'
          : 'project-rail-shell pointer-events-auto flex w-[60px] flex-col items-center gap-2 rounded-3xl border-2 border-border/95 bg-background/55 px-1 py-3 shadow-xl backdrop-blur-xl'
      }
    >
      <div
        ref={projectListRef}
        className={cn(
          'project-rail-scroll flex max-h-[292px] w-full flex-col items-center gap-2 overflow-y-auto px-0 py-2',
          standalone && 'max-h-none min-h-0 py-3',
          isDragging && 'is-dragging'
        )}
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
              className="relative"
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
                  'relative flex h-10 w-10 items-center justify-center rounded-2xl border text-[11px] font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.04] hover:shadow-lg',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                    : 'border-border/70 bg-secondary/60 text-foreground hover:border-primary/40 hover:bg-secondary'
                )}
              >
                <span className="max-w-[30px] truncate text-[14px] font-bold uppercase leading-none">
                  {Array.from(project.name)
                    .slice(0, 2)
                    .join('')
                    .toUpperCase() || '项目'}
                </span>
                {visualState === 'loading' ? (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full border border-background bg-background">
                    <span className="h-2 w-2 animate-spin rounded-full border border-primary border-t-transparent" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-background',
                      meta.dotClassName,
                      meta.pulseClassName
                    )}
                  />
                )}
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
        {visibleProjects.length === 0 &&
        !isProjectsLoading &&
        !isResolvingStandaloneProjects ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            暂无项目
          </div>
        ) : null}
      </div>

      <div className="h-px w-8 shrink-0 justify-self-center bg-border/75" />

      <div
        className={cn(
          'flex shrink-0 flex-col items-center gap-2 pt-0.5',
          standalone && 'pb-3 pt-2'
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className="project-rail-action-button h-8 w-8 rounded-2xl"
          onClick={handleCreateProject}
          aria-label="创建新项目"
          title="创建新项目"
        >
          <Plus className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="project-rail-action-button h-8 w-8 rounded-2xl"
          onClick={handleOpenProject}
          aria-label="打开项目"
          title="打开项目"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>

        {standalone ? (
          <Button
            variant="ghost"
            size="icon"
            className="project-rail-action-button h-8 w-8 rounded-2xl"
            onClick={handleCloseRail}
            aria-label="关闭项目栏"
            title="关闭项目栏"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div className="h-screen w-screen overflow-hidden rounded-[18px] bg-transparent">
        {shell}
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed left-3 top-1/2 z-40 -translate-y-1/2">
      {shell}
    </div>
  );
}
