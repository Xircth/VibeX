import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  Check,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  Search,
} from 'lucide-react';
import { useAppContextMenu } from '@/components/context-menu';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import {
  deriveProjectVisualState,
  resolveProjectVisualStateMeta,
} from '@/components/layout/ProjectActivityUi';
import {
  buildProjectRailTree,
  filterProjectsByQuery,
  formatCompactProjectPath,
  pickDefaultProjectTarget,
} from '@/components/layout/projectRailProjects';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { useProject } from '@/contexts/ProjectContext';
import { useProjects } from '@/hooks/useProjects';
import { useProjectSwitcher } from '@/hooks/useProjectSwitcher';
import { projectsApi } from '@/lib/api';
import { importedProjectName } from '@/lib/importedProject';
import { initProjectGitWithPrompt } from '@/lib/initProjectGit';
import { normalizeProjectRoute, paths } from '@/lib/paths';
import {
  PROJECT_DELETE_CONFIRM_CLASSNAME,
  PROJECT_DELETE_CONFIRM_STYLE,
} from '@/lib/projectDeleteUi';
import { cn } from '@/lib/utils';
import {
  useWindowProjectsStore,
  type ProjectActivityVisualState,
} from '@/stores/useWindowProjectsStore';
import { isMac } from '@/utils/platform';

type EnrichedProjectNode = {
  id: string;
  name: string;
  displayName: string;
  root_path?: string;
  compactPath: string;
  is_git?: boolean;
  is_home?: boolean;
  parent_project_id?: string | null;
  depth: number;
  visualState: ProjectActivityVisualState;
  runningCount: number;
};

function isAttentionState(state: ProjectActivityVisualState): boolean {
  return (
    state === 'loading' ||
    state === 'error-unread' ||
    state === 'success-unread'
  );
}

export function ProjectQuickSwitcher() {
  const { t } = useTranslation(['panels', 'common', 'app']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openSurfaceMenu } = useAppContextMenu();
  const { project, projectId } = useProject();
  const { projects, projectsById, isLoading: isProjectsLoading } = useProjects();
  const switchProject = useProjectSwitcher();

  const open = useWindowProjectsStore((state) => state.railVisible);
  const setOpen = useWindowProjectsStore((state) => state.setRailVisible);
  const openProjectIds = useWindowProjectsStore(
    (state) => state.openProjectIds
  );
  const lastRouteByProject = useWindowProjectsStore(
    (state) => state.lastRouteByProject
  );
  const projectSnapshots = useWindowProjectsStore(
    (state) => state.projectSnapshots
  );
  const projectAlerts = useWindowProjectsStore((state) => state.projectAlerts);
  const removedProjectIds = useWindowProjectsStore(
    (state) => state.removedProjectIds
  );
  const ensureProjectOpen = useWindowProjectsStore(
    (state) => state.ensureProjectOpen
  );
  const removeProjectState = useWindowProjectsStore(
    (state) => state.removeProjectState
  );

  const visibleProjects = useMemo(
    () => projects.filter((candidate) => !removedProjectIds[candidate.id]),
    [projects, removedProjectIds]
  );

  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const resolvedProject =
    project ?? (projectId ? projectsById?.[projectId] : undefined);
  const resolvedProjectId = resolvedProject?.id ?? projectId;
  const activeProjectName = resolvedProject
    ? importedProjectName(resolvedProject, (key) => t(key, { ns: 'app' }))
    : null;

  const activeSnapshot = resolvedProjectId
    ? projectSnapshots[resolvedProjectId]
    : undefined;
  const activeVisualState =
    resolvedProjectId && activeSnapshot
      ? deriveProjectVisualState(
          activeSnapshot,
          projectAlerts[resolvedProjectId]
        )
      : 'idle';
  const activeStatusMeta = resolveProjectVisualStateMeta(activeVisualState);

  const backgroundSummary = useMemo(() => {
    let count = 0;
    let hasError = false;
    for (const candidate of visibleProjects) {
      if (candidate.id === resolvedProjectId) continue;
      const snapshot = projectSnapshots[candidate.id];
      const alert = projectAlerts[candidate.id];
      const isRunning = Boolean(snapshot?.isLoading || snapshot?.hasRunning);
      const isUnread = Boolean(alert?.unread);
      if (isRunning || isUnread) {
        count += 1;
        if (alert?.kind === 'error' && alert.unread) {
          hasError = true;
        }
      }
    }
    return { count, hasError };
  }, [projectAlerts, projectSnapshots, resolvedProjectId, visibleProjects]);

  const treeNodes = useMemo<EnrichedProjectNode[]>(() => {
    return buildProjectRailTree(visibleProjects).map((item) => {
      const snapshot = projectSnapshots[item.id];
      const visualState = snapshot
        ? deriveProjectVisualState(snapshot, projectAlerts[item.id])
        : 'idle';
      return {
        id: item.id,
        name: item.name,
        displayName: importedProjectName(item, (key) => t(key, { ns: 'app' })),
        root_path: item.root_path,
        compactPath: formatCompactProjectPath(item.root_path),
        is_git: item.is_git,
        is_home: item.is_home,
        parent_project_id: item.parent_project_id,
        depth: item.depth,
        visualState,
        runningCount: snapshot?.runningCount ?? 0,
      };
    });
  }, [projectAlerts, projectSnapshots, t, visibleProjects]);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const { attentionItems, regularItems, flatItems } = useMemo(() => {
    if (isSearching) {
      const matched = filterProjectsByQuery(treeNodes, trimmedQuery).map(
        (node) => ({ ...node, depth: 0 })
      );
      return {
        attentionItems: [] as EnrichedProjectNode[],
        regularItems: matched,
        flatItems: matched,
      };
    }

    const pinned = treeNodes
      .filter((node) => isAttentionState(node.visualState))
      .map((node) => ({ ...node, depth: 0 }));
    if (pinned.length === 0 || pinned.length === treeNodes.length) {
      return {
        attentionItems: [] as EnrichedProjectNode[],
        regularItems: treeNodes,
        flatItems: treeNodes,
      };
    }

    const pinnedIds = new Set(pinned.map((node) => node.id));
    const rest = treeNodes.filter((node) => !pinnedIds.has(node.id));
    return {
      attentionItems: pinned,
      regularItems: rest,
      flatItems: [...pinned, ...rest],
    };
  }, [isSearching, treeNodes, trimmedQuery]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) {
        return;
      }
      const hasMod = event.metaKey || event.ctrlKey;
      if (
        hasMod &&
        event.altKey &&
        !event.shiftKey &&
        (event.code === 'KeyP' || event.key.toLowerCase() === 'p')
      ) {
        event.preventDefault();
        setOpen(!useWindowProjectsStore.getState().railVisible);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [setOpen]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) {
      setQuery('');
      return;
    }
    if (!justOpened) {
      return;
    }
    const activeIdx = flatItems.findIndex(
      (item) => item.id === resolvedProjectId
    );
    setHighlightedIndex(activeIdx >= 0 ? activeIdx : 0);
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flatItems, open, resolvedProjectId]);

  useEffect(() => {
    if (highlightedIndex >= flatItems.length) {
      setHighlightedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, highlightedIndex]);

  const handleSelectProject = useCallback(
    (nextProjectId: string) => {
      setOpen(false);
      switchProject(nextProjectId);
    },
    [setOpen, switchProject]
  );

  const handleOpenFolder = useCallback(async () => {
    setOpen(false);
    const result = await ProjectFormDialog.show({ autoOpenFolderPicker: true });
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  }, [ensureProjectOpen, queryClient, setOpen, switchProject]);

  const handleCreateProject = useCallback(async () => {
    setOpen(false);
    const result = await ProjectFormDialog.show({});
    if (result?.status === 'saved' && result.project) {
      ensureProjectOpen(result.project.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      switchProject(
        result.project.id,
        paths.projectSessions(result.project.id)
      );
    }
  }, [ensureProjectOpen, queryClient, setOpen, switchProject]);

  const handleCloneRepo = useCallback(async () => {
    setOpen(false);
    const result = await CloneRepoDialog.show();
    if (result.status !== 'cloned') {
      return;
    }
    const name = result.repo.display_name || result.repo.name;
    try {
      const created = await projectsApi.create({
        name,
        repositories: [{ display_name: name, git_repo_path: result.repo.path }],
      });
      ensureProjectOpen(created.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      switchProject(created.id, paths.projectSessions(created.id));
    } catch (error) {
      toast.error(
        t('app:welcomePage.createProjectFailed', { error: String(error) })
      );
    }
  }, [ensureProjectOpen, queryClient, setOpen, switchProject, t]);

  const handleDeleteProject = useCallback(
    async (target: { id: string; displayName: string }) => {
      setOpen(false);
      const result = await ConfirmDialog.show({
        title: t('projectRail.deleteConfirmTitle', {
          name: target.displayName,
        }),
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
        await projectsApi.delete(target.id);
        removeProjectState(target.id);
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        toast.success(
          t('projectRail.deleteSuccess', { name: target.displayName })
        );

        if (target.id === resolvedProjectId) {
          const fallbackId = pickDefaultProjectTarget({
            projects: visibleProjects,
            projectsById,
            openProjectIds,
            excludeProjectId: target.id,
          });
          if (fallbackId) {
            ensureProjectOpen(fallbackId);
            navigate(
              normalizeProjectRoute(
                lastRouteByProject[fallbackId] ??
                  paths.projectSessions(fallbackId)
              ),
              { replace: true }
            );
          } else {
            navigate(paths.projects(), { replace: true });
          }
        }
      } catch (error) {
        console.error('Failed to remove project:', error);
        toast.error(t('projectRail.deleteFailed'));
      }
    },
    [
      ensureProjectOpen,
      lastRouteByProject,
      navigate,
      openProjectIds,
      projectsById,
      queryClient,
      removeProjectState,
      resolvedProjectId,
      setOpen,
      t,
      visibleProjects,
    ]
  );

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flatItems.length === 0) return;
      const next = (highlightedIndex + 1) % flatItems.length;
      setHighlightedIndex(next);
      const nextId = flatItems[next]?.id;
      if (nextId) {
        itemRefs.current.get(nextId)?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flatItems.length === 0) return;
      const prev =
        (highlightedIndex - 1 + flatItems.length) % flatItems.length;
      setHighlightedIndex(prev);
      const prevId = flatItems[prev]?.id;
      if (prevId) {
        itemRefs.current.get(prevId)?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const target = flatItems[highlightedIndex];
      if (target) {
        handleSelectProject(target.id);
      }
      return;
    }

    if (event.key === 'Escape' && query.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
      setHighlightedIndex(0);
    }
  };

  const renderProjectRow = (node: EnrichedProjectNode, flatIdx: number) => {
    const isActive = node.id === resolvedProjectId;
    const isHighlighted = flatIdx === highlightedIndex;
    const statusMeta = resolveProjectVisualStateMeta(node.visualState);
    const Icon = node.is_git ? GitBranch : FolderOpen;

    return (
      <div
        key={node.id}
        style={
          !isSearching && node.depth > 0
            ? { paddingLeft: `${node.depth * 14}px` }
            : undefined
        }
        draggable={!isSearching && !node.is_home}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/project-id', node.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('text/project-id')) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = event.dataTransfer.getData('text/project-id');
          if (!sourceId || sourceId === node.id) return;
          const source = treeNodes.find((item) => item.id === sourceId);
          const parentPath = node.root_path;
          const childPath = source?.root_path;
          if (!parentPath || !childPath) return;
          const parentNorm = parentPath.replace(/\\/g, '/').replace(/\/$/, '');
          const childNorm = childPath.replace(/\\/g, '/').replace(/\/$/, '');
          if (!childNorm.startsWith(`${parentNorm}/`)) return;
          void projectsApi.setParent(sourceId, node.id).catch(() => {
            toast.error(t('projectRail.deleteFailed'));
          });
        }}
      >
        <button
          ref={(element) => {
            if (element) {
              itemRefs.current.set(node.id, element);
            } else {
              itemRefs.current.delete(node.id);
            }
          }}
          type="button"
          role="option"
          aria-selected={isActive}
          data-testid={`project-switcher-item-${node.id}`}
          onMouseEnter={() => setHighlightedIndex(flatIdx)}
          onClick={() => handleSelectProject(node.id)}
          onContextMenu={(event) => {
            event.stopPropagation();
            openSurfaceMenu(event, [
              {
                id: 'open',
                label: t('common:contextMenu.open'),
                onSelect: () => handleSelectProject(node.id),
              },
              ...(!node.is_git && !node.is_home
                ? [
                    {
                      id: 'init-git',
                      label: t('projectRail.initGit'),
                      onSelect: () => {
                        setOpen(false);
                        void initProjectGitWithPrompt({
                          id: node.id,
                          name: node.displayName,
                          is_git: Boolean(node.is_git),
                        });
                      },
                    },
                  ]
                : []),
              ...(!node.is_home
                ? [
                    {
                      id: 'remove',
                      label: t('projectRail.removeAction'),
                      danger: true,
                      onSelect: () => {
                        void handleDeleteProject({
                          id: node.id,
                          displayName: node.displayName,
                        });
                      },
                    },
                  ]
                : []),
            ]);
          }}
          className={cn(
            'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isHighlighted
              ? 'bg-foreground/[0.08] text-foreground'
              : 'text-foreground/90 hover:bg-foreground/[0.05]'
          )}
        >
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground group-hover:text-foreground'
            )}
            aria-hidden="true"
          />

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'truncate text-xs',
                  isActive ? 'font-semibold text-foreground' : 'font-medium'
                )}
              >
                {node.displayName}
              </span>
            </span>
            {node.compactPath ? (
              <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                {node.compactPath}
              </span>
            ) : null}
          </span>

          <span className="flex shrink-0 items-center gap-1.5">
            {node.visualState === 'loading' ? (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
                <Loader2
                  className="h-2.5 w-2.5 animate-spin"
                  aria-hidden="true"
                />
                {node.runningCount > 0 ? node.runningCount : null}
              </span>
            ) : node.visualState !== 'idle' ? (
              <span
                title={statusMeta.label}
                className={cn(
                  'h-2 w-2 rounded-full',
                  statusMeta.dotClassName,
                  statusMeta.pulseClassName
                )}
              />
            ) : null}

            {isActive ? (
              <Check
                className="h-3.5 w-3.5 shrink-0 text-primary"
                aria-hidden="true"
              />
            ) : null}
          </span>
        </button>
      </div>
    );
  };

  const shortcutHint = isMac() ? '⌥⌘P' : 'Ctrl+Alt+P';
  const triggerLabel = activeProjectName
    ? t('projectSwitcher.triggerAria', {
        name: activeProjectName,
        defaultValue: `切换项目（当前：${activeProjectName}）`,
      })
    : t('projectSwitcher.selectOrCreate', '选择或创建项目');

  const ActiveTriggerIcon = resolvedProject?.is_git ? GitBranch : FolderOpen;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="toolbar-project-switcher"
          data-basic-guide="project-switcher"
          aria-label={triggerLabel}
          aria-expanded={open}
          title={`${triggerLabel} (${shortcutHint})`}
          className={cn(
            'workspace-toolbar-button flex h-7 max-w-52 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            'hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            open && 'bg-foreground/[0.08]',
            !activeProjectName && 'text-muted-foreground hover:text-foreground'
          )}
        >
          <ActiveTriggerIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              activeProjectName ? 'text-primary' : 'text-muted-foreground'
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">
            {activeProjectName ??
              t('projectSwitcher.selectOrCreate', '选择或创建项目')}
          </span>

          {resolvedProjectId ? (
            activeVisualState === 'loading' ? (
              <Loader2
                data-testid="project-switcher-status-spinner"
                className="h-3 w-3 shrink-0 animate-spin text-primary"
                aria-hidden="true"
              />
            ) : activeVisualState !== 'idle' ? (
              <span
                data-testid="project-switcher-status-dot"
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  activeStatusMeta.dotClassName,
                  activeStatusMeta.pulseClassName
                )}
              />
            ) : null
          ) : null}

          {backgroundSummary.count > 0 ? (
            <span
              data-testid="project-switcher-background-badge"
              className={cn(
                'rounded px-1 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
                backgroundSummary.hasError
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-primary/15 text-primary'
              )}
            >
              +{backgroundSummary.count}
            </span>
          ) : null}

          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 opacity-60 transition-transform duration-150',
              open && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        data-testid="project-switcher-popover"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
        className="w-[356px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/80 p-0 shadow-xl"
      >
        <div
          data-testid="project-switcher-actions"
          className="grid grid-cols-3 gap-1 border-b border-border/60 p-1.5"
        >
          <button
            type="button"
            data-testid="project-switcher-open-folder"
            onClick={() => void handleOpenFolder()}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {t('app:welcomePage.selectFolder', '选择文件夹')}
            </span>
          </button>

          <button
            type="button"
            data-testid="project-switcher-create-project"
            onClick={() => void handleCreateProject()}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {t('app:welcomePage.createNewProject', '创建新项目')}
            </span>
          </button>

          <button
            type="button"
            data-testid="project-switcher-clone-repo"
            onClick={() => void handleCloneRepo()}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {t('app:welcomePage.cloneRepo', '克隆仓库')}
            </span>
          </button>
        </div>

        <div
          data-testid="project-switcher-search-section"
          className="px-2 pt-2 pb-0.5"
        >
          <TextInput
            ref={searchInputRef}
            label={t(
              'projectSwitcher.searchPlaceholder',
              '搜索项目名称或路径…'
            )}
            isLabelHidden
            size="sm"
            width="100%"
            className="[&_input]:text-sm"
            value={query}
            onChange={(nextValue) => {
              setQuery(nextValue);
              setHighlightedIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={t(
              'projectSwitcher.searchPlaceholder',
              '搜索项目名称或路径…'
            )}
            hasClear
            startIcon={
              <Search
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            }
            data-testid="project-switcher-search-input"
          />
        </div>

        <div
          role="listbox"
          aria-label={t('projectRail.title')}
          className="max-h-[340px] overflow-y-auto px-1.5 pt-1 pb-1.5"
          onContextMenu={(event) => {
            openSurfaceMenu(event, [
              {
                id: 'open-folder',
                label: t('common:contextMenu.openFolder'),
                onSelect: () => {
                  void handleOpenFolder();
                },
              },
              {
                id: 'new-project',
                label: t('common:contextMenu.newProject'),
                onSelect: () => {
                  void handleCreateProject();
                },
              },
              {
                id: 'clone-repo',
                label: t('app:welcomePage.cloneRepo', '克隆仓库'),
                onSelect: () => {
                  void handleCloneRepo();
                },
              },
            ]);
          }}
        >
          {treeNodes.length === 0 && !isProjectsLoading ? (
            <div className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
              {t(
                'projectSwitcher.emptyProjects',
                '尚未导入项目，可通过上方入口打开文件夹、新建项目或克隆仓库。'
              )}
            </div>
          ) : flatItems.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('projectSwitcher.noMatch', '未找到匹配的项目')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {attentionItems.length > 0 ? (
                <div className="pb-1">
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('projectSwitcher.attentionSection', '运行与待关注')}
                  </div>
                  <div className="space-y-0.5">
                    {attentionItems.map((node, idx) =>
                      renderProjectRow(node, idx)
                    )}
                  </div>
                </div>
              ) : null}

              {regularItems.length > 0 ? (
                <div>
                  {attentionItems.length > 0 ? (
                    <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('projectSwitcher.allProjectsSection', '全部项目')}
                    </div>
                  ) : null}
                  <div className="space-y-0.5">
                    {regularItems.map((node, idx) =>
                      renderProjectRow(node, attentionItems.length + idx)
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
