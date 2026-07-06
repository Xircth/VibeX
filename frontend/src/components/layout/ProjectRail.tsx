import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/useProjects';
import { useProject } from '@/contexts/ProjectContext';
import { normalizeProjectRoute, paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { desktopApi, projectsApi } from '@/lib/api';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { toast } from 'sonner';
import {
  deriveProjectVisualState,
  ProjectRecentSessionsPopover,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
import {
  buildProjectRailOrderedIds,
  capProjectRailVisibleCount,
  mergeProjectsById,
} from '@/components/layout/projectRailProjects';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
  PROJECT_DELETE_TOAST_OPTIONS,
} from '@/lib/projectDeleteUi';

export function ProjectRail({ standalone = false }: { standalone?: boolean }) {
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

    const loadProjects = async () => {
      setIsResolvingStandaloneProjects(true);

      try {
        const data = await projectsApi.getAll();
        if (cancelled) {
          return;
        }

        const mergedProjects = mergeProjectsById(projects, data);
        if (mergedProjects.length > 0 || !hasStoredProjectSignals) {
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

  const effectiveProjects = useMemo(
    () =>
      standalone ? mergeProjectsById(projects, fallbackProjects) : projects,
    [fallbackProjects, projects, standalone]
  );
  const orderedProjectIds = useMemo(
    () =>
      buildProjectRailOrderedIds({
        openProjectIds,
        currentProjectId: projectId,
        projectSnapshotIds: Object.keys(projectSnapshots),
        projectIds: effectiveProjects.map((project) => project.id),
        preferProjectListOrder: standalone,
      }),
    [effectiveProjects, openProjectIds, projectId, projectSnapshots, standalone]
  );
  const shouldShowPlaceholderProjects =
    standalone &&
    effectiveProjects.length === 0 &&
    isResolvingStandaloneProjects &&
    hasStoredProjectSignals;
  const projectRailItemCount = capProjectRailVisibleCount(
    effectiveProjects.length > 0
      ? effectiveProjects.length
      : shouldShowPlaceholderProjects
        ? orderedProjectIds.length
        : 0
  );

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
            name: t('projectRail.placeholderProjectName'),
          };
        }

        return null;
      })
      .filter((project): project is { id: string; name: string } =>
        Boolean(project)
      );
  }, [effectiveProjects, orderedProjectIds, shouldShowPlaceholderProjects, t]);

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
    if (standalone) {
      await desktopApi.requestProjectRailProjectDialog({ mode: 'create' });
      return;
    }

    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(result.project.id, paths.projectSessions(result.project.id));
    }
  };

  const handleOpenProject = async () => {
    if (standalone) {
      await desktopApi.requestProjectRailProjectDialog({ mode: 'open' });
      return;
    }

    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      switchProject(result.project.id, paths.projectSessions(result.project.id));
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
        t('projectRail.deleteSuccess', { name: targetProject.name }),
        PROJECT_DELETE_TOAST_OPTIONS
      );
    } catch (error) {
      console.error('Failed to delete project from project rail:', error);
      toast.error(t('projectRail.deleteFailed'), PROJECT_DELETE_TOAST_OPTIONS);
    }
  };

  if (!standalone && !railVisible) {
    return null;
  }

  const shell = (
    <div
      ref={railRef}
      className={
        standalone
          ? 'project-rail-shell pointer-events-auto grid h-full w-full grid-rows-[minmax(0,1fr)_auto_auto] overflow-hidden rounded-[18px] px-1 py-3'
          : 'project-rail-shell pointer-events-auto flex w-[60px] flex-col items-center gap-2 rounded-[18px] px-1 py-3'
      }
    >
      <div
        ref={projectListRef}
        className={cn(
          'project-rail-scroll flex max-h-[292px] w-full flex-col items-center gap-2 overflow-y-auto px-0 py-2',
          standalone && 'max-h-[432px] min-h-0 py-3',
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
              className="group relative"
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
                  'project-rail-item-button relative flex h-10 w-10 items-center justify-center rounded-xl border text-[11px] font-semibold transition-colors duration-150',
                  isActive && 'is-active'
                )}
              >
                <span className="max-w-[30px] truncate text-[14px] font-bold uppercase leading-none">
                  {Array.from(project.name)
                    .slice(0, 2)
                    .join('')
                    .toUpperCase() || t('projectRail.placeholderProjectName')}
                </span>
                {visualState === 'loading' ? (
                  <span className="project-rail-status-dot-shell absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full">
                    <span className="h-2 w-2 animate-spin rounded-full border border-primary border-t-transparent" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      'project-rail-status-dot absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full',
                      meta.dotClassName,
                      meta.pulseClassName
                    )}
                    />
                )}
              </button>

              {standalone ? (
                <button
                  type="button"
                  className="project-rail-delete-button absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
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
                  <Trash2 className="h-2.5 w-2.5" />
                </button>
              ) : null}

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
            {t('projectRail.emptyState')}
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
          className="project-rail-action-button h-8 w-8 rounded-lg"
          onClick={handleCreateProject}
          aria-label={t('projectRail.createProjectAria')}
          title={t('projectRail.createProjectAria')}
        >
          <Plus className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="project-rail-action-button h-8 w-8 rounded-lg"
          onClick={handleOpenProject}
          aria-label={t('projectRail.openProjectAria')}
          title={t('projectRail.openProjectAria')}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>

        {standalone ? (
          <Button
            variant="ghost"
            size="icon"
            className="project-rail-action-button h-8 w-8 rounded-lg"
            onClick={handleCloseRail}
            aria-label={t('projectRail.closeRailAria')}
            title={t('projectRail.closeRailAria')}
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
