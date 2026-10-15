import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { toast } from '@/components/ui/toast';
import { useTranslation } from 'react-i18next';
import {
  FilePlus,
  FolderPlus,
  Plus,
  RefreshCw,
  Search,
  SquareMinus,
} from 'lucide-react';
import FileIcon from '../FileIcon';
import { desktopApi, fileTreeApi } from '../../lib/api';
import { useBinaryAssetPreview } from '@/hooks/useFileContent';
import { type FileReferencePayload } from '../../utils/fileReferences';
import {
  clearCurrentDraggedFileReference,
  getFileReferenceDragState,
  setCurrentDraggedFileReference,
  subscribeFileReferenceDrag,
  updateFileReferenceDragPointer,
} from '../../utils/fileReferenceDrag';
import { FilePreviewPopover } from './FilePreviewPopover';
import { FileTreeNameInput } from './FileTreeNameInput';
import {
  acknowledgeFileTreeSearch,
  subscribeFileTreeSearch,
} from './fileTreeSearchRequest';
import {
  useWorkspaceTextSearch,
  WorkspaceFileSearchField,
  WorkspaceFileSearchResults,
} from './WorkspaceFileSearch';
import type { FileTreeNode, FileOpenLocation } from './file-tree-types';
import { EMPTY_DIRECTORIES, EMPTY_SET } from './file-tree-constants';
import {
  deriveFileTreeContextMenuHeader,
  deriveFileTreeEntries,
  deriveFileTreeGitStatusMap,
  deriveFileTreeKeyboardAction,
  deriveFileTreeNodeViewState,
  deriveFilePreviewAnchor,
  deriveFilePreviewDisplayState,
  deriveFilePreviewSelectionRange,
  deriveFolderGitStatusMap,
  expandFileTreeFoldersForSelection,
  ensureFileTreeParentFolderExpanded,
  getFileTreeExpansionPaths,
  getFileTreeAbsoluteClipboardText,
  getFileTreeInlineNewInputConfig,
  getFileTreeMentionText,
  getFileTreeRelativeClipboardText,
  getFilePreviewImagePath,
  getFilePreviewInsertionText,
  getFilePreviewKind,
  getFilePreviewSelectionHints,
  buildTree,
  buildFileTreeDeleteConfirmation,
  buildNewFileTreeItemRelativePath,
  collectDirectChildFolderPaths,
  collectFileTreeExpandAllSeedPaths,
  completeFileTreeExpandAllPath,
  createFileTreeExpandAllSession,
  enqueueFileTreeExpandAllPaths,
  FILE_TREE_EXPAND_ALL_CONCURRENCY,
  getAreAllVisibleFileTreeFoldersExpanded,
  isFileTreeExpandAllSessionIdle,
  normalizeDirectoryChildrenResponse,
  pruneExpandedFileTreeFolders,
  replaceFileTreeDirectoryListing,
  takeNextFileTreeExpandAllPaths,
  type FileTreeExpandAllSession,
  type FileTreeLazyListing,
  resolveFileTreeAbsolutePath,
  resolveWorkspaceRootLabel,
  toggleAllFileTreeFolders,
  toggleFileTreeFolder,
} from './file-tree-utils';
import { ConfirmDialog } from '@/components/dialogs';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { formatFileTreeStructure } from './fileTreeStructure';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { useLocalDesktopHost } from '@/lib/desktopShell';
import '@/styles/file-tree.css';
import {
  EMPTY_EXPANDED_FOLDERS,
  EMPTY_LAZY_LISTING,
  useFileTreeStore,
  type FileTreeRevealTarget,
} from '@/stores/useFileTreeStore';

type LoadLazyDirectoryChildrenResult =
  | { status: 'skipped' }
  | { status: 'loaded'; directories: string[] }
  | { status: 'error'; message: string };

export type FileTreePanelProps = {
  workspacePath: string;
  workspaceName?: string;
  files: string[];
  directories?: string[];
  isLoading: boolean;
  onOpenFile?: (path: string, location?: FileOpenLocation) => void;
  onInsertText?: (text: string) => void;
  gitStatusFiles?: { path: string; status: string }[];
  gitignoredFiles?: Set<string>;
  gitignoredDirectories?: Set<string>;
  onRefreshFiles?: () => void;
  onRenamePath?: (oldPath: string, newPath: string) => void;
  refreshToken?: number;
  lazyLoadAllDirectories?: boolean;
  revealTarget?: FileTreeRevealTarget | null;
};

export function FileTreePanel({
  workspaceName,
  workspacePath,
  files,
  directories,
  isLoading,
  onInsertText,
  onOpenFile,
  gitStatusFiles,
  gitignoredFiles,
  gitignoredDirectories,
  onRefreshFiles,
  onRenamePath,
  refreshToken = 0,
  lazyLoadAllDirectories = true,
  revealTarget = null,
}: FileTreePanelProps) {
  const { t } = useTranslation(['panels', 'common']);
  const localDesktopHost = useLocalDesktopHost();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const search = useWorkspaceTextSearch(workspacePath || null);
  const setSearchQuery = search.setQuery;

  const closeFileSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, [setSearchQuery]);

  useEffect(() => {
    return subscribeFileTreeSearch(() => {
      setSearchOpen(true);
      setSearchFocusNonce((value) => value + 1);
      acknowledgeFileTreeSearch();
    });
  }, []);

  useEffect(() => {
    if (!searchOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const element =
        target instanceof Element
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      if (!element) return;
      if (element.closest('[data-file-tree-search-overlay]')) return;
      if (element.closest('[data-file-tree-search-result]')) return;
      if (element.closest('[data-file-tree-search-chrome]')) return;
      if (element.closest('.product-context-menu')) return;
      if (element.closest('.file-tree-row')) return;
      if (element.closest('[popover]')) return;
      if (element.closest('.astryx-typeahead-dropdown')) return;
      closeFileSearch();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeFileSearch();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeFileSearch, searchOpen]);

  const directoryEntries = directories ?? EMPTY_DIRECTORIES;
  const ignoredFileEntries = gitignoredFiles ?? EMPTY_SET;
  const ignoredDirectoryEntries = gitignoredDirectories ?? EMPTY_SET;
  const expandedFolders = useFileTreeStore(
    (state) =>
      state.expandedByRoot[workspacePath] ??
      (EMPTY_EXPANDED_FOLDERS as Set<string>)
  );
  const setExpandedFoldersForRoot = useFileTreeStore(
    (state) => state.setExpandedFolders
  );
  const setExpandedFolders = useCallback(
    (update: Set<string> | ((previous: Set<string>) => Set<string>)) => {
      setExpandedFoldersForRoot(workspacePath, update);
    },
    [setExpandedFoldersForRoot, workspacePath]
  );
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{
    top: number;
    left: number;
    arrowTop: number;
    height: number;
  } | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewSelection, setPreviewSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const dragAnchorLineRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [selectedNodeType, setSelectedNodeType] = useState<
    'file' | 'folder' | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    relativePath: string;
    isFolder: boolean;
  } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragCandidateRef = useRef<{
    payload: FileReferencePayload;
    startX: number;
    startY: number;
  } | null>(null);
  // Abort controller for the active custom drag's window listeners, so they are
  // removed if the panel unmounts mid-drag (pointerup would never fire).
  const dragAbortRef = useRef<AbortController | null>(null);
  const suppressClickPathRef = useRef<string | null>(null);
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<FileTreeNode | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const lazyListing = useFileTreeStore(
    (state) => state.lazyListingByRoot[workspacePath] ?? EMPTY_LAZY_LISTING
  );
  const setLazyListingForRoot = useFileTreeStore(
    (state) => state.setLazyListing
  );
  const setLazyListing = useCallback(
    (
      update:
        | FileTreeLazyListing
        | ((previous: FileTreeLazyListing) => FileTreeLazyListing)
    ) => {
      setLazyListingForRoot(workspacePath, update);
    },
    [setLazyListingForRoot, workspacePath]
  );
  const [loadingLazyDirectories, setLoadingLazyDirectories] = useState<
    Set<string>
  >(new Set());
  const [lazyDirectoryLoadErrors, setLazyDirectoryLoadErrors] = useState<
    Map<string, string>
  >(new Map());
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [dragOverlay, setDragOverlay] = useState<{
    payload: FileReferencePayload;
    x: number;
    y: number;
  } | null>(null);
  const loadedLazyDirectoriesRef = useRef<Set<string>>(new Set());
  const loadingLazyDirectoriesRef = useRef<Set<string>>(new Set());
  const inflightLazyDirectoryLoadsRef = useRef(
    new Map<string, Promise<LoadLazyDirectoryChildrenResult>>()
  );
  const folderPathsRef = useRef<Set<string>>(new Set());
  const expandAllGenerationRef = useRef(0);
  const expandAllSessionRef = useRef<FileTreeExpandAllSession | null>(null);
  const previousRefreshTokenRef = useRef(refreshToken);
  const [isExpandingAll, setIsExpandingAll] = useState(false);

  const workspaceRootLabel = useMemo(
    () => resolveWorkspaceRootLabel(workspacePath, workspaceName),
    [workspaceName, workspacePath]
  );
  const previewKind = useMemo(
    () => getFilePreviewKind(previewPath),
    [previewPath]
  );
  const {
    mergedFiles,
    mergedDirectories,
    mergedGitignoredFiles,
    mergedGitignoredDirectories,
    effectiveLazyLoadableDirectories,
  } = useMemo(
    () =>
      deriveFileTreeEntries({
        files,
        directories: directoryEntries,
        ignoredFiles: ignoredFileEntries,
        ignoredDirectories: ignoredDirectoryEntries,
        lazyFiles: lazyListing.files,
        lazyDirectories: lazyListing.directories,
        lazyGitignoredFiles: lazyListing.gitignoredFiles,
        lazyGitignoredDirectories: lazyListing.gitignoredDirectories,
        lazyLoadableDirectories: lazyListing.loadableDirectories,
        lazyLoadAllDirectories,
      }),
    [
      directoryEntries,
      files,
      ignoredDirectoryEntries,
      ignoredFileEntries,
      lazyListing,
      lazyLoadAllDirectories,
    ]
  );
  const showLoading =
    isLoading && mergedFiles.length === 0 && mergedDirectories.length === 0;

  const gitStatusMap = useMemo(
    () => deriveFileTreeGitStatusMap(gitStatusFiles),
    [gitStatusFiles]
  );

  const { nodes, folderPaths } = useMemo(
    () =>
      buildTree(
        mergedFiles,
        mergedDirectories,
        effectiveLazyLoadableDirectories
      ),
    [effectiveLazyLoadableDirectories, mergedDirectories, mergedFiles]
  );

  const folderGitStatusMap = useMemo(() => {
    if (gitStatusMap.size === 0) {
      return new Map<string, string>();
    }
    return deriveFolderGitStatusMap(nodes, gitStatusMap);
  }, [nodes, gitStatusMap]);

  const visibleFolderPaths = folderPaths;
  folderPathsRef.current = folderPaths;
  const hasFolders = visibleFolderPaths.size > 0;
  const allVisibleExpanded = getAreAllVisibleFileTreeFoldersExpanded(
    visibleFolderPaths,
    expandedFolders
  );
  const showCollapseAll = isExpandingAll || allVisibleExpanded;

  useEffect(() => {
    setExpandedFolders((prev) =>
      pruneExpandedFileTreeFolders(
        prev,
        folderPaths,
        lazyListing.loadedDirectories
      )
    );
  }, [folderPaths, lazyListing.loadedDirectories, setExpandedFolders]);

  useEffect(() => {
    loadedLazyDirectoriesRef.current = new Set(lazyListing.loadedDirectories);
  }, [lazyListing.loadedDirectories]);

  useEffect(() => {
    loadingLazyDirectoriesRef.current = loadingLazyDirectories;
  }, [loadingLazyDirectories]);

  // Reset all state when workspace changes
  useEffect(() => {
    setPreviewPath(null);
    setPreviewAnchor(null);
    setPreviewSelection(null);
    setPreviewContent('');
    setPreviewTruncated(false);
    setPreviewError(null);
    setPreviewLoading(false);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
    setContextMenu(null);
    setLoadingLazyDirectories(new Set());
    setLazyDirectoryLoadErrors(new Map());
    setNewFileParent(null);
    setNewFileName('');
    setNewFolderParent(null);
    setNewFolderName('');
    setRenameTarget(null);
    setRenameName('');
    setRenameError(null);
    setDropTargetPath(null);
    setDragOverlay(null);
    dragCandidateRef.current = null;
    suppressClickPathRef.current = null;
    loadedLazyDirectoriesRef.current = new Set();
    loadingLazyDirectoriesRef.current = new Set();
    inflightLazyDirectoryLoadsRef.current = new Map();
    expandAllGenerationRef.current += 1;
    expandAllSessionRef.current = null;
    setIsExpandingAll(false);
    return () => {
      expandAllGenerationRef.current += 1;
      expandAllSessionRef.current = null;
    };
  }, [workspacePath]);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    setPreviewAnchor(null);
    setPreviewSelection(null);
    setPreviewContent('');
    setPreviewTruncated(false);
    setPreviewError(null);
    setPreviewLoading(false);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
  }, []);

  const loadLazyDirectoryChildren = useCallback(
    async (
      path: string,
      options?: { force?: boolean }
    ): Promise<LoadLazyDirectoryChildrenResult> => {
      if (!options?.force) {
        const inflight = inflightLazyDirectoryLoadsRef.current.get(path);
        if (inflight) {
          return inflight;
        }
        if (loadedLazyDirectoriesRef.current.has(path)) {
          return { status: 'skipped' };
        }
      }

      const run = (async (): Promise<LoadLazyDirectoryChildrenResult> => {
        if (options?.force) {
          const nextLoaded = new Set(loadedLazyDirectoriesRef.current);
          nextLoaded.delete(path);
          loadedLazyDirectoriesRef.current = nextLoaded;
        }

        const nextLoading = new Set(loadingLazyDirectoriesRef.current);
        nextLoading.add(path);
        loadingLazyDirectoriesRef.current = nextLoading;
        setLoadingLazyDirectories(nextLoading);

        setLazyDirectoryLoadErrors((prev) => {
          if (!prev.has(path)) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(path);
          return next;
        });

        try {
          const response = normalizeDirectoryChildrenResponse(
            await fileTreeApi.listDirectoryChildren(workspacePath, path)
          );
          setLazyListing((current) => {
            const next = replaceFileTreeDirectoryListing({
              parentPath: path,
              listing: response,
              current,
            });
            loadedLazyDirectoriesRef.current = new Set(next.loadedDirectories);
            return next;
          });
          return { status: 'loaded', directories: response.directories };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          setLazyDirectoryLoadErrors((prev) => {
            const next = new Map(prev);
            next.set(path, message);
            return next;
          });
          return { status: 'error', message };
        } finally {
          const nextLoading = new Set(loadingLazyDirectoriesRef.current);
          nextLoading.delete(path);
          loadingLazyDirectoriesRef.current = nextLoading;
          setLoadingLazyDirectories(nextLoading);
        }
      })();

      inflightLazyDirectoryLoadsRef.current.set(path, run);
      try {
        return await run;
      } finally {
        inflightLazyDirectoryLoadsRef.current.delete(path);
      }
    },
    [setLazyListing, workspacePath]
  );

  useEffect(() => {
    const expanded = useFileTreeStore.getState().expandedByRoot[workspacePath];
    expanded?.forEach((path) => {
      void loadLazyDirectoryChildren(path);
    });
  }, [loadLazyDirectoryChildren, workspacePath]);

  useEffect(() => {
    if (previousRefreshTokenRef.current === refreshToken) {
      return;
    }
    previousRefreshTokenRef.current = refreshToken;

    const expandedLazyDirectories = Array.from(
      loadedLazyDirectoriesRef.current
    ).filter((path) => expandedFolders.has(path));

    setLazyListing((current) => {
      const nextLoaded = new Set(
        Array.from(current.loadedDirectories).filter((path) =>
          expandedFolders.has(path)
        )
      );
      loadedLazyDirectoriesRef.current = nextLoaded;
      return {
        ...current,
        loadedDirectories: nextLoaded,
      };
    });

    expandedLazyDirectories.forEach((path) => {
      void loadLazyDirectoryChildren(path, { force: true });
    });
  }, [
    expandedFolders,
    loadLazyDirectoryChildren,
    refreshToken,
    setLazyListing,
  ]);

  useEffect(() => {
    if (!revealTarget) {
      return;
    }

    setExpandedFolders((prev) =>
      expandFileTreeFoldersForSelection(
        prev,
        revealTarget.path,
        revealTarget.nodeType
      )
    );
    setSelectedNodePath(revealTarget.path);
    setSelectedNodeType(revealTarget.nodeType);

    for (const expansionPath of getFileTreeExpansionPaths(
      revealTarget.path,
      revealTarget.nodeType
    )) {
      void loadLazyDirectoryChildren(expansionPath);
    }
  }, [loadLazyDirectoryChildren, revealTarget, setExpandedFolders]);

  useEffect(() => {
    if (!previewPath) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewPath, closePreview]);

  useEffect(() => {
    return subscribeFileReferenceDrag((state) => {
      if (!state.isDragging || !state.payload || !state.pointer) {
        setDragOverlay(null);
        return;
      }
      setDragOverlay({
        payload: state.payload,
        x: state.pointer.x,
        y: state.pointer.y,
      });
    });
  }, []);

  const stopExpandAll = useCallback(() => {
    expandAllGenerationRef.current += 1;
    expandAllSessionRef.current = null;
    setIsExpandingAll(false);
  }, []);

  const expandFolderPath = useCallback(
    (path: string) => {
      setExpandedFolders((prev) => {
        if (prev.has(path)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [setExpandedFolders]
  );

  const childFoldersOf = useCallback((path: string) => {
    return collectDirectChildFolderPaths(path, folderPathsRef.current);
  }, []);

  const pumpExpandAll = useCallback(() => {
    const session = expandAllSessionRef.current;
    if (!session) {
      return;
    }
    const generation = session.generation;
    const batch = takeNextFileTreeExpandAllPaths(
      session,
      FILE_TREE_EXPAND_ALL_CONCURRENCY
    );
    if (batch.length === 0) {
      if (isFileTreeExpandAllSessionIdle(session)) {
        expandAllSessionRef.current = null;
        setIsExpandingAll(false);
      }
      return;
    }

    for (const path of batch) {
      void (async () => {
        let childDirectories: string[] = [];
        if (loadedLazyDirectoriesRef.current.has(path)) {
          expandFolderPath(path);
          childDirectories = childFoldersOf(path);
        } else {
          const result = await loadLazyDirectoryChildren(path);
          if (expandAllGenerationRef.current !== generation) {
            return;
          }
          if (result.status === 'loaded') {
            childDirectories = result.directories;
          } else if (result.status === 'skipped') {
            childDirectories = childFoldersOf(path);
          }
          expandFolderPath(path);
        }

        if (expandAllGenerationRef.current !== generation) {
          return;
        }
        const currentSession = expandAllSessionRef.current;
        if (!currentSession || currentSession.generation !== generation) {
          return;
        }
        completeFileTreeExpandAllPath(currentSession, path, childDirectories);
        pumpExpandAll();
      })();
    }
  }, [childFoldersOf, expandFolderPath, loadLazyDirectoryChildren]);

  const retryLazyDirectory = useCallback(
    (path: string) => {
      void (async () => {
        const result = await loadLazyDirectoryChildren(path, { force: true });
        const session = expandAllSessionRef.current;
        if (
          !session ||
          result.status !== 'loaded' ||
          expandAllGenerationRef.current !== session.generation
        ) {
          return;
        }
        enqueueFileTreeExpandAllPaths(session, result.directories);
        pumpExpandAll();
      })();
    },
    [loadLazyDirectoryChildren, pumpExpandAll]
  );

  const toggleAllFolders = () => {
    if (!hasFolders) {
      return;
    }
    if (showCollapseAll) {
      stopExpandAll();
      setExpandedFolders((prev) =>
        toggleAllFileTreeFolders({
          expandedFolders: prev,
          visibleFolderPaths,
          allVisibleExpanded: true,
        })
      );
      return;
    }

    const generation = expandAllGenerationRef.current + 1;
    expandAllGenerationRef.current = generation;
    const session = createFileTreeExpandAllSession(
      generation,
      collectFileTreeExpandAllSeedPaths(folderPaths)
    );
    expandAllSessionRef.current = session;
    setIsExpandingAll(true);
    pumpExpandAll();
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => toggleFileTreeFolder(prev, path));
  };

  const resolvePath = useCallback(
    (relativePath: string) =>
      resolveFileTreeAbsolutePath(workspacePath, relativePath),
    [workspacePath]
  );

  const previewImagePath = useMemo(
    () =>
      getFilePreviewImagePath({
        previewKind,
        previewPath,
        workspacePath,
      }),
    [previewKind, previewPath, workspacePath]
  );
  const {
    assetUrl: previewImageSrc,
    isLoading: isLoadingPreviewImage,
    error: previewImageError,
  } = useBinaryAssetPreview(previewImagePath);

  const openPreview = useCallback((path: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const anchor = deriveFilePreviewAnchor({
      targetRect: rect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPreviewPath(path);
    setPreviewAnchor(anchor);
    setPreviewSelection(null);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
  }, []);

  // Load file content for preview
  useEffect(() => {
    if (!previewPath) {
      return;
    }
    let cancelled = false;
    if (previewKind === 'image') {
      setPreviewContent('');
      setPreviewTruncated(false);
      setPreviewError(null);
      setPreviewLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setPreviewLoading(true);
    setPreviewError(null);
    const absolutePath = resolvePath(previewPath);
    fileTreeApi
      .readFileWithTruncation(absolutePath)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPreviewContent(response.content ?? '');
        setPreviewTruncated(Boolean(response.truncated));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setPreviewError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewKind, previewPath, resolvePath]);

  useEffect(() => {
    if (!isDragSelecting) {
      return;
    }
    const handleMouseUp = () => {
      setIsDragSelecting(false);
      dragAnchorLineRef.current = null;
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [isDragSelecting]);

  const { loading: effectivePreviewLoading, error: effectivePreviewError } =
    deriveFilePreviewDisplayState({
      previewKind,
      textLoading: previewLoading,
      textError: previewError,
      imageLoading: isLoadingPreviewImage,
      imageError: previewImageError,
    });

  const selectRangeFromAnchor = useCallback((anchor: number, index: number) => {
    setPreviewSelection(deriveFilePreviewSelectionRange(anchor, index));
  }, []);

  const handleSelectLine = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        return;
      }
      if (event.shiftKey && previewSelection) {
        const anchor = previewSelection.start;
        selectRangeFromAnchor(anchor, index);
        return;
      }
      setPreviewSelection({ start: index, end: index });
    },
    [previewSelection, selectRangeFromAnchor]
  );

  const handleLineMouseDown = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (previewKind !== 'text' || event.button !== 0) {
        return;
      }
      event.preventDefault();
      setIsDragSelecting(true);
      const anchor =
        event.shiftKey && previewSelection ? previewSelection.start : index;
      dragAnchorLineRef.current = anchor;
      dragMovedRef.current = false;
      selectRangeFromAnchor(anchor, index);
    },
    [previewKind, previewSelection, selectRangeFromAnchor]
  );

  const handleLineMouseEnter = useCallback(
    (index: number, _event: MouseEvent<HTMLButtonElement>) => {
      if (!isDragSelecting) {
        return;
      }
      const anchor = dragAnchorLineRef.current;
      if (anchor === null) {
        return;
      }
      if (anchor !== index) {
        dragMovedRef.current = true;
      }
      selectRangeFromAnchor(anchor, index);
    },
    [isDragSelecting, selectRangeFromAnchor]
  );

  const handleLineMouseUp = useCallback(() => {
    if (!isDragSelecting) {
      return;
    }
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
  }, [isDragSelecting]);

  const selectionHints = useMemo(
    () => getFilePreviewSelectionHints(previewKind),
    [previewKind]
  );

  const handleAddSelection = useCallback(() => {
    if (!onInsertText) {
      return;
    }

    const insertionText = getFilePreviewInsertionText({
      previewKind,
      path: previewPath,
      content: previewContent,
      selection: previewSelection,
    });
    if (!insertionText) {
      return;
    }

    onInsertText(insertionText);
    closePreview();
  }, [
    previewContent,
    previewKind,
    previewPath,
    previewSelection,
    onInsertText,
    closePreview,
  ]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const copyAbsolutePath = useCallback(
    async (relativePath: string) => {
      try {
        await navigator.clipboard.writeText(
          getFileTreeAbsoluteClipboardText(
            relativePath,
            relativePath ? resolvePath(relativePath) : workspacePath,
            workspacePath
          )
        );
      } catch {
        // clipboard write is not critical
      }
    },
    [resolvePath, workspacePath]
  );

  const copyRelativePath = useCallback(async (relativePath: string) => {
    try {
      await navigator.clipboard.writeText(
        getFileTreeRelativeClipboardText(relativePath)
      );
    } catch {
      // clipboard write is not critical
    }
  }, []);

  const openInFileManager = useCallback(
    async (relativePath: string, _isFolder: boolean) => {
      try {
        const absolutePath = relativePath
          ? resolvePath(relativePath)
          : workspacePath;
        await desktopApi.revealInFileManager(absolutePath);
      } catch (error) {
        console.error('Failed to reveal path in file manager:', error);
      }
    },
    [resolvePath, workspacePath]
  );

  const trashItem = useCallback(
    async (relativePath: string, isFolder: boolean) => {
      const confirmed = await ConfirmDialog.show(
        buildFileTreeDeleteConfirmation(relativePath, isFolder)
      );

      if (confirmed !== 'confirmed') {
        return;
      }

      try {
        const absolutePath = resolvePath(relativePath);
        await fileTreeApi.trashItem(absolutePath);
        if (selectedNodePath === relativePath) {
          setSelectedNodePath(null);
          setSelectedNodeType(null);
        }
        onRefreshFiles?.();
      } catch (e) {
        console.error('Failed to trash item:', e);
        toast.error(t('fileTreeMenu.deleteFailed'));
      }
    },
    [resolvePath, onRefreshFiles, selectedNodePath, t]
  );

  const duplicateItem = useCallback(
    async (relativePath: string) => {
      try {
        const absolutePath = resolvePath(relativePath);
        await fileTreeApi.copyItem(absolutePath);
        onRefreshFiles?.();
      } catch (e) {
        console.error('Failed to duplicate item:', e);
        toast.error(t('fileTreeMenu.duplicateFailed'));
      }
    },
    [resolvePath, onRefreshFiles, t]
  );

  const openNewFilePrompt = useCallback(
    (parentFolder: string) => {
      setRenameTarget(null);
      setNewFolderParent(null);
      setNewFolderName('');
      setNewFileParent(parentFolder);
      setNewFileName('');
      setExpandedFolders((prev) =>
        ensureFileTreeParentFolderExpanded(prev, parentFolder)
      );
      if (parentFolder) {
        void loadLazyDirectoryChildren(parentFolder);
      }
    },
    [loadLazyDirectoryChildren, setExpandedFolders]
  );

  const confirmNewFile = useCallback(async () => {
    if (newFileParent === null) return;
    const relativePath = buildNewFileTreeItemRelativePath(
      newFileParent,
      newFileName,
      getFileTreeInlineNewInputConfig('file').fallbackName
    );
    try {
      const absolutePath = resolvePath(relativePath);
      await fileTreeApi.saveFile(absolutePath, '');
      setLazyListing((current) => {
        const files = new Set(current.files);
        files.add(relativePath);
        return { ...current, files };
      });
      if (newFileParent) {
        void loadLazyDirectoryChildren(newFileParent, { force: true });
      }
      onRefreshFiles?.();
    } catch (e) {
      console.error('Failed to create file:', e);
      toast.error(t('fileTreeMenu.createFileFailed'));
    }
    setNewFileParent(null);
    setNewFileName('');
  }, [
    loadLazyDirectoryChildren,
    newFileName,
    newFileParent,
    onRefreshFiles,
    resolvePath,
    setLazyListing,
    t,
  ]);

  const cancelNewFile = useCallback(() => {
    setNewFileParent(null);
    setNewFileName('');
  }, []);

  const openNewFolderPrompt = useCallback(
    (parentFolder: string) => {
      setRenameTarget(null);
      setNewFileParent(null);
      setNewFileName('');
      setNewFolderParent(parentFolder);
      setNewFolderName('');
      setExpandedFolders((prev) =>
        ensureFileTreeParentFolderExpanded(prev, parentFolder)
      );
      if (parentFolder) {
        void loadLazyDirectoryChildren(parentFolder);
      }
    },
    [loadLazyDirectoryChildren, setExpandedFolders]
  );

  const confirmNewFolder = useCallback(async () => {
    if (newFolderParent === null) return;
    const relativePath = buildNewFileTreeItemRelativePath(
      newFolderParent,
      newFolderName,
      getFileTreeInlineNewInputConfig('folder').fallbackName
    );
    try {
      const absolutePath = resolvePath(relativePath);
      await fileTreeApi.createDirectory(absolutePath);
      setLazyListing((current) => {
        const directories = new Set(current.directories);
        const loadableDirectories = new Set(current.loadableDirectories);
        directories.add(relativePath);
        loadableDirectories.add(relativePath);
        return { ...current, directories, loadableDirectories };
      });
      if (newFolderParent) {
        void loadLazyDirectoryChildren(newFolderParent, { force: true });
      }
      onRefreshFiles?.();
    } catch (e) {
      console.error('Failed to create folder:', e);
      toast.error(t('fileTreeMenu.createFolderFailed'));
    }
    setNewFolderParent(null);
    setNewFolderName('');
  }, [
    loadLazyDirectoryChildren,
    newFolderName,
    newFolderParent,
    onRefreshFiles,
    resolvePath,
    setLazyListing,
    t,
  ]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParent(null);
    setNewFolderName('');
  }, []);

  const cancelRename = useCallback(() => {
    setRenameTarget(null);
    setRenameName('');
    setRenameError(null);
  }, []);

  const openRenamePrompt = (path: string, isFolder: boolean) => {
    setNewFileParent(null);
    setNewFolderParent(null);
    const name = path.split('/').pop() ?? path;
    setRenameTarget({
      path,
      name,
      type: isFolder ? 'folder' : 'file',
      children: [],
    });
    setRenameName(name);
    setRenameError(null);
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[<>:"/\\|?*]/.test(name) ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32)
    ) {
      setRenameError(t('fileTreeMenu.invalidName'));
      return;
    }
    if (name === renameTarget.name) {
      cancelRename();
      return;
    }
    const parent = renameTarget.path.includes('/')
      ? renameTarget.path.slice(0, renameTarget.path.lastIndexOf('/'))
      : '';
    const nextPath = parent ? `${parent}/${name}` : name;
    try {
      await fileTreeApi.moveItem(
        resolvePath(renameTarget.path),
        resolvePath(nextPath)
      );
      const remap = (path: string) =>
        path === renameTarget.path || path.startsWith(`${renameTarget.path}/`)
          ? nextPath + path.slice(renameTarget.path.length)
          : path;
      const remapSet = (paths: Set<string>) =>
        new Set(Array.from(paths, remap));
      setLazyListing((current) => ({
        files: remapSet(current.files),
        directories: remapSet(current.directories),
        gitignoredFiles: remapSet(current.gitignoredFiles),
        gitignoredDirectories: remapSet(current.gitignoredDirectories),
        loadableDirectories: remapSet(current.loadableDirectories),
        loadedDirectories: remapSet(current.loadedDirectories),
      }));
      setExpandedFolders(remapSet);
      setSelectedNodePath(nextPath);
      setSelectedNodeType(renameTarget.type);
      closePreview();
      onRenamePath?.(renameTarget.path, nextPath);
      cancelRename();
      void loadLazyDirectoryChildren(parent, { force: true });
      onRefreshFiles?.();
    } catch (error) {
      setRenameError(
        t('fileTreeMenu.renameFailed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  const resolveParentFolderForNode = useCallback(
    (relativePath: string | null, nodeType: 'file' | 'folder' | null) => {
      if (!relativePath) {
        return '';
      }
      if (nodeType === 'folder') {
        return relativePath;
      }
      const separatorIndex = relativePath.lastIndexOf('/');
      return separatorIndex >= 0 ? relativePath.slice(0, separatorIndex) : '';
    },
    []
  );

  const buildMoveDestinationRelativePath = useCallback(
    (sourceRelativePath: string, targetDirectoryPath: string) => {
      const segments = sourceRelativePath.split('/').filter(Boolean);
      const leafName = segments.at(-1) ?? sourceRelativePath;
      return targetDirectoryPath
        ? `${targetDirectoryPath}/${leafName}`
        : leafName;
    },
    []
  );

  const canDropIntoDirectory = useCallback(
    (dragged: FileReferencePayload | null, targetDirectoryPath: string) => {
      if (!dragged) {
        return false;
      }

      const sourcePath = dragged.relativePath;
      if (!sourcePath) {
        return false;
      }

      if (sourcePath === targetDirectoryPath) {
        return false;
      }

      const sourceType = dragged.kind === 'directory' ? 'folder' : 'file';
      const sourceParent = resolveParentFolderForNode(sourcePath, sourceType);
      if (sourceParent === targetDirectoryPath) {
        return false;
      }

      return !(
        dragged.kind === 'directory' &&
        targetDirectoryPath.startsWith(`${sourcePath}/`)
      );
    },
    [resolveParentFolderForNode]
  );

  const moveDraggedNode = useCallback(
    async (dragged: FileReferencePayload, targetDirectoryPath: string) => {
      if (!canDropIntoDirectory(dragged, targetDirectoryPath)) {
        return;
      }

      const nextRelativePath = buildMoveDestinationRelativePath(
        dragged.relativePath,
        targetDirectoryPath
      );

      try {
        await fileTreeApi.moveItem(
          resolvePath(dragged.relativePath),
          resolvePath(nextRelativePath)
        );
        if (targetDirectoryPath) {
          setExpandedFolders((prev) => {
            if (prev.has(targetDirectoryPath)) {
              return prev;
            }
            const next = new Set(prev);
            next.add(targetDirectoryPath);
            return next;
          });
        }
        setSelectedNodePath(nextRelativePath);
        setSelectedNodeType(dragged.kind === 'directory' ? 'folder' : 'file');
        onRefreshFiles?.();
      } catch (error) {
        console.error('Failed to move item:', error);
        toast.error('Failed to move item');
      } finally {
        clearCurrentDraggedFileReference();
        setDropTargetPath(null);
      }
    },
    [
      buildMoveDestinationRelativePath,
      canDropIntoDirectory,
      onRefreshFiles,
      resolvePath,
      setExpandedFolders,
    ]
  );

  const resolveDropTargetPathFromPoint = useCallback((x: number, y: number) => {
    if (typeof document === 'undefined') {
      return null;
    }
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const dropTarget = element.closest('[data-file-tree-drop-path]');
    if (!(dropTarget instanceof HTMLElement)) {
      return null;
    }
    return dropTarget.getAttribute('data-file-tree-drop-path');
  }, []);

  const dispatchDropToExternalZone = useCallback((x: number, y: number) => {
    if (typeof document === 'undefined') {
      return false;
    }
    const state = getFileReferenceDragState();
    if (!state.payload) {
      return false;
    }
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const dropZone = element.closest('[data-file-reference-drop-zone]');
    if (!(dropZone instanceof HTMLElement)) {
      return false;
    }
    dropZone.dispatchEvent(
      new CustomEvent('vibe-file-reference-drop', {
        detail: state.payload,
        bubbles: false,
      })
    );
    return true;
  }, []);

  const endCustomDrag = useCallback(
    (clientX: number, clientY: number) => {
      const dragState = getFileReferenceDragState();
      const payload = dragState.payload;
      if (!payload) {
        clearCurrentDraggedFileReference();
        setDropTargetPath(null);
        return;
      }

      const targetPath = resolveDropTargetPathFromPoint(clientX, clientY);
      if (targetPath !== null && canDropIntoDirectory(payload, targetPath)) {
        void moveDraggedNode(payload, targetPath);
        return;
      }

      if (dispatchDropToExternalZone(clientX, clientY)) {
        clearCurrentDraggedFileReference();
        setDropTargetPath(null);
        return;
      }

      clearCurrentDraggedFileReference();
      setDropTargetPath(null);
    },
    [
      canDropIntoDirectory,
      dispatchDropToExternalZone,
      moveDraggedNode,
      resolveDropTargetPathFromPoint,
    ]
  );

  const beginPointerDrag = useCallback(
    (payload: FileReferencePayload, event: React.PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      dragCandidateRef.current = {
        payload,
        startX: event.clientX,
        startY: event.clientY,
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const candidate = dragCandidateRef.current;
        if (!candidate) {
          return;
        }

        const dragState = getFileReferenceDragState();
        const deltaX = moveEvent.clientX - candidate.startX;
        const deltaY = moveEvent.clientY - candidate.startY;
        const distance = Math.hypot(deltaX, deltaY);

        if (!dragState.isDragging && distance < 6) {
          return;
        }

        if (!dragState.isDragging) {
          setCurrentDraggedFileReference(candidate.payload);
          suppressClickPathRef.current = candidate.payload.relativePath;
        }

        updateFileReferenceDragPointer({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        });

        const hoveredPath = resolveDropTargetPathFromPoint(
          moveEvent.clientX,
          moveEvent.clientY
        );
        if (
          hoveredPath !== null &&
          canDropIntoDirectory(candidate.payload, hoveredPath)
        ) {
          setDropTargetPath(hoveredPath);
        } else {
          setDropTargetPath(null);
        }
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        dragAbortRef.current?.abort();
        dragAbortRef.current = null;

        const wasDragging = getFileReferenceDragState().isDragging;
        dragCandidateRef.current = null;

        if (!wasDragging) {
          return;
        }

        endCustomDrag(upEvent.clientX, upEvent.clientY);
      };

      // Clean up any prior drag, then bind this drag's listeners to a fresh
      // AbortController so the unmount effect can remove them too.
      dragAbortRef.current?.abort();
      const dragController = new AbortController();
      dragAbortRef.current = dragController;
      const { signal } = dragController;
      window.addEventListener('pointermove', handlePointerMove, { signal });
      window.addEventListener('pointerup', handlePointerUp, { signal });
      window.addEventListener('pointercancel', handlePointerUp, { signal });
    },
    [canDropIntoDirectory, endCustomDrag, resolveDropTargetPathFromPoint]
  );

  // Belt-and-suspenders: if the panel unmounts mid-drag, drop the window
  // listeners that pointerup would otherwise have removed.
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  const selectedParentFolder = useMemo(
    () => resolveParentFolderForNode(selectedNodePath, selectedNodeType),
    [resolveParentFolderForNode, selectedNodePath, selectedNodeType]
  );
  const contextMenuParentFolder = useMemo(
    () =>
      resolveParentFolderForNode(
        contextMenu?.relativePath ?? '',
        contextMenu?.isFolder ? 'folder' : 'file'
      ),
    [
      contextMenu?.isFolder,
      contextMenu?.relativePath,
      resolveParentFolderForNode,
    ]
  );
  const contextMenuHeader = useMemo(
    () =>
      contextMenu
        ? deriveFileTreeContextMenuHeader(
            contextMenu.relativePath,
            workspaceRootLabel
          )
        : null,
    [contextMenu, workspaceRootLabel]
  );

  const showContextMenu = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      relativePath: string,
      isFolder: boolean
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        relativePath,
        isFolder,
      });
    },
    []
  );

  const fileTreeContextMenuItems = useMemo<ProductContextMenuItem[]>(() => {
    if (!contextMenu) return [];

    const items: ProductContextMenuItem[] = [
      {
        id: 'new-file',
        label: t('fileTreeMenu.newFile'),
        onSelect: () => {
          openNewFilePrompt(contextMenuParentFolder);
        },
      },
      {
        id: 'new-folder',
        label: t('fileTreeMenu.newFolder'),
        onSelect: () => {
          openNewFolderPrompt(contextMenuParentFolder);
        },
      },
    ];

    if (contextMenu.relativePath) {
      items.push({
        id: 'rename',
        label: t('fileTreeMenu.rename'),
        onSelect: () => {
          openRenamePrompt(contextMenu.relativePath, contextMenu.isFolder);
        },
      });
    } else {
      items.push(
        {
          id: showCollapseAll ? 'collapse-all' : 'expand-all',
          label: showCollapseAll
            ? t('common:contextMenu.collapseAll')
            : t('common:contextMenu.expandAll'),
          onSelect: () => {
            toggleAllFolders();
          },
        },
        {
          id: 'copy-tree-structure',
          label: t('common:contextMenu.copyTreeStructure'),
          onSelect: () => {
            void writeClipboardViaBridge(formatFileTreeStructure(nodes));
          },
        },
        {
          id: 'copy-root-path',
          label: t('common:contextMenu.copyRootPath'),
          onSelect: () => {
            void copyAbsolutePath('');
          },
        }
      );
    }

    const copyChildren: ProductContextMenuItem[] = [];
    if (contextMenu.relativePath && !contextMenu.isFolder) {
      copyChildren.push({
        id: 'duplicate',
        label: t('fileTreeMenu.duplicate'),
        onSelect: () => {
          void duplicateItem(contextMenu.relativePath);
        },
      });
    }
    copyChildren.push(
      {
        id: 'copy-relative-path',
        label: t('fileTreeMenu.copyRelativePath'),
        onSelect: () => {
          void copyRelativePath(contextMenu.relativePath);
        },
      },
      {
        id: 'copy-absolute-path',
        label: t('fileTreeMenu.copyAbsolutePath'),
        onSelect: () => {
          void copyAbsolutePath(contextMenu.relativePath);
        },
      }
    );

    items.push({
      id: 'copy',
      type: 'submenu',
      label: t('fileTreeMenu.copy'),
      children: copyChildren,
    });

    if (localDesktopHost) {
      items.push({
        id: 'open-in-file-manager',
        label: t('fileTreeMenu.openInFileManager'),
        onSelect: () => {
          void openInFileManager(
            contextMenu.relativePath,
            contextMenu.isFolder
          );
        },
      });
    }

    if (contextMenu.relativePath) {
      items.push({
        id: 'delete-sep',
        type: 'separator',
      });
      items.push({
        id: 'delete',
        label: t('common:delete'),
        danger: true,
        onSelect: () => {
          void trashItem(contextMenu.relativePath, contextMenu.isFolder);
        },
      });
    }

    return items;
  }, [
    contextMenu,
    contextMenuParentFolder,
    copyAbsolutePath,
    copyRelativePath,
    duplicateItem,
    localDesktopHost,
    nodes,
    openInFileManager,
    openNewFilePrompt,
    openNewFolderPrompt,
    openRenamePrompt,
    showCollapseAll,
    t,
    toggleAllFolders,
    trashItem,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedNodePath || !selectedNodeType) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }
      if (panelRef.current && !panelRef.current.contains(target)) {
        return;
      }

      const action = deriveFileTreeKeyboardAction({
        selectedNodePath,
        selectedNodeType,
        isMac: navigator.platform.includes('Mac'),
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });

      if (action?.type === 'delete') {
        event.preventDefault();
        void trashItem(selectedNodePath, selectedNodeType === 'folder');
        return;
      }

      if (action?.type === 'copyAbsolutePath') {
        event.preventDefault();
        void copyAbsolutePath(selectedNodePath);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodePath, selectedNodeType, trashItem, copyAbsolutePath]);

  const renderInlineNewInput = (
    type: 'file' | 'folder',
    depth: number,
    rename = false
  ) => {
    const isFile = type === 'file';
    const inputConfig = getFileTreeInlineNewInputConfig(type);
    const name = rename ? renameName : isFile ? newFileName : newFolderName;
    const setName = rename
      ? setRenameName
      : isFile
        ? setNewFileName
        : setNewFolderName;
    const doConfirm = rename
      ? confirmRename
      : isFile
        ? confirmNewFile
        : confirmNewFolder;
    const doCancel = rename
      ? cancelRename
      : isFile
        ? cancelNewFile
        : cancelNewFolder;

    return (
      <div key={`__inline-new-${type}`} className="file-tree-row-wrap">
        <div
          className={`file-tree-row is-file file-tree-inline-new-row`}
          style={{ paddingLeft: `${depth * 10}px` }}
        >
          <span className="file-tree-spacer" aria-hidden />
          <span className="file-tree-icon" aria-hidden>
            <FileIcon
              filePath={inputConfig.iconPath}
              isFolder={inputConfig.isFolder}
              isOpen={false}
            />
          </span>
          <FileTreeNameInput
            label={t(
              rename
                ? 'fileTreeMenu.rename'
                : isFile
                  ? 'fileTreeMenu.newFile'
                  : 'fileTreeMenu.newFolder'
            )}
            value={name}
            placeholder={inputConfig.fallbackName}
            selectName={rename}
            error={rename ? renameError : null}
            onChange={(value) => {
              setName(value);
              if (rename) setRenameError(null);
            }}
            onConfirm={doConfirm}
            onCancel={doCancel}
          />
        </div>
      </div>
    );
  };

  const renderNode = (node: FileTreeNode, depth: number) => {
    const {
      isFolder,
      isLazyFolder,
      hasChildren,
      canExpand,
      isExpanded,
      isLazyLoading,
      lazyLoadError,
      gitStatusClass,
      rowClassName,
    } = deriveFileTreeNodeViewState({
      node,
      expandedFolders,
      loadingLazyDirectories,
      lazyDirectoryLoadErrors,
      folderGitStatusMap,
      gitStatusMap,
      mergedGitignoredDirectories,
      mergedGitignoredFiles,
      selectedNodePath,
      dropTargetPath,
    });
    return (
      <div key={node.path}>
        {renameTarget?.path === node.path ? (
          renderInlineNewInput(node.type, depth, true)
        ) : (
          <div className="file-tree-row-wrap">
            <button
              type="button"
              className={rowClassName}
              style={{ paddingLeft: `${depth * 10}px` }}
              onClick={(event) => {
                if (suppressClickPathRef.current === node.path) {
                  suppressClickPathRef.current = null;
                  event.preventDefault();
                  return;
                }
                setSelectedNodePath(node.path);
                setSelectedNodeType(node.type);
                if (isFolder) {
                  if (canExpand) {
                    const shouldExpand = !expandedFolders.has(node.path);
                    toggleFolder(node.path);
                    if (shouldExpand && isLazyFolder) {
                      void loadLazyDirectoryChildren(node.path);
                    }
                  }
                  return;
                }
                if (onOpenFile) {
                  onOpenFile(node.path);
                } else {
                  openPreview(node.path, event.currentTarget);
                }
              }}
              onContextMenu={(event) => {
                setSelectedNodePath(node.path);
                setSelectedNodeType(node.type);
                void showContextMenu(event, node.path, isFolder);
              }}
              onPointerDown={(event) =>
                beginPointerDrag(
                  {
                    fileName: node.name,
                    relativePath: node.path,
                    kind: isFolder ? 'directory' : 'file',
                  },
                  event
                )
              }
              data-file-tree-drop-path={isFolder ? node.path : undefined}
            >
              {isFolder && canExpand ? (
                <span
                  className={`file-tree-chevron${isExpanded ? ' is-open' : ''}`}
                >
                  {'>'}
                </span>
              ) : (
                <span className="file-tree-spacer" aria-hidden />
              )}
              <span className="file-tree-icon" aria-hidden>
                <FileIcon
                  filePath={node.name}
                  isFolder={isFolder}
                  isOpen={isExpanded}
                />
              </span>
              <span className={`file-tree-name${gitStatusClass}`}>
                {node.name}
              </span>
            </button>
            {onInsertText && (
              <button
                type="button"
                className={`ghost icon-button file-tree-action${selectedNodePath === node.path ? ' is-visible' : ''}`}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onInsertText(getFileTreeMentionText(node.path, node.type));
                }}
                aria-label={t('fileTreeMenu.referenceNode', {
                  name: node.name,
                })}
                title={t('fileTreeMenu.referenceToChat')}
              >
                <Plus size={10} aria-hidden />
              </button>
            )}
          </div>
        )}
        {isFolder &&
          isExpanded &&
          !(isLazyFolder && node.children.length === 0) &&
          (hasChildren ||
            newFolderParent === node.path ||
            newFileParent === node.path) && (
            <div className="file-tree-children">
              {newFolderParent === node.path &&
                renderInlineNewInput('folder', depth + 1)}
              {newFileParent === node.path &&
                renderInlineNewInput('file', depth + 1)}
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        {isLazyFolder &&
          isExpanded &&
          node.children.length === 0 &&
          (isLazyLoading ||
            lazyLoadError ||
            newFolderParent === node.path ||
            newFileParent === node.path) && (
            <div className="file-tree-children">
              {newFolderParent === node.path &&
                renderInlineNewInput('folder', depth + 1)}
              {newFileParent === node.path &&
                renderInlineNewInput('file', depth + 1)}
              {isLazyLoading ? (
                <div className="file-tree-lazy-state">
                  {t('fileTreeMenu.loading')}
                </div>
              ) : lazyLoadError ? (
                <button
                  type="button"
                  className="file-tree-lazy-retry"
                  onClick={() => retryLazyDirectory(node.path)}
                  title={lazyLoadError}
                >
                  {t('fileTreeMenu.loadFailedRetry')}
                </button>
              ) : null}
            </div>
          )}
      </div>
    );
  };

  return (
    <aside className="diff-panel file-tree-panel" ref={panelRef}>
      <div className="file-tree-top-zone">
        {searchOpen ? (
          <div
            className="file-tree-search-overlay"
            data-file-tree-search-overlay=""
          >
            <WorkspaceFileSearchField
              search={search}
              autoFocus
              focusNonce={searchFocusNonce}
            />
          </div>
        ) : (
          <div className="file-tree-root-row">
            <div className="file-tree-root-wrap">
              <button
                type="button"
                className={`file-tree-row is-folder is-root${selectedNodePath === '' ? ' is-selected' : ''}${dropTargetPath === '' ? ' is-drop-target' : ''}`}
                data-file-tree-drop-path=""
                aria-expanded="true"
                onClick={() => {
                  if (suppressClickPathRef.current === '') {
                    suppressClickPathRef.current = null;
                    return;
                  }
                  setSelectedNodePath('');
                  setSelectedNodeType('folder');
                }}
                onContextMenu={(event) => {
                  setSelectedNodePath('');
                  setSelectedNodeType('folder');
                  void showContextMenu(event, '', true);
                }}
                onPointerDown={(event) =>
                  beginPointerDrag(
                    {
                      fileName: workspaceRootLabel,
                      relativePath: '',
                      kind: 'directory',
                    },
                    event
                  )
                }
              >
                <span className="file-tree-name">{workspaceRootLabel}</span>
              </button>
            </div>
            <div className="file-tree-root-actions">
              <button
                type="button"
                className="ghost icon-button file-tree-root-action"
                onClick={() => openNewFilePrompt(selectedParentFolder)}
                aria-label={t('fileTreeMenu.newFile')}
                title={t('fileTreeMenu.newFile')}
              >
                <FilePlus size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="ghost icon-button file-tree-root-action"
                onClick={() => openNewFolderPrompt(selectedParentFolder)}
                aria-label={t('fileTreeMenu.newFolder')}
                title={t('fileTreeMenu.newFolder')}
              >
                <FolderPlus size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="ghost icon-button file-tree-root-action"
                onClick={() => onRefreshFiles?.()}
                disabled={!onRefreshFiles}
                aria-label={t('fileTreeMenu.refreshFileTree')}
                title={t('fileTreeMenu.refreshFileTree')}
              >
                <RefreshCw
                  size={14}
                  aria-hidden
                  className={isLoading ? 'animate-spin' : undefined}
                />
              </button>
              <button
                type="button"
                className="ghost icon-button file-tree-root-action"
                onClick={toggleAllFolders}
                disabled={!hasFolders}
                aria-label={
                  showCollapseAll
                    ? t('fileTreeMenu.collapseAllFolders')
                    : t('fileTreeMenu.expandAllFolders')
                }
                title={
                  showCollapseAll
                    ? t('fileTreeMenu.collapseAllFolders')
                    : t('fileTreeMenu.expandAllFolders')
                }
              >
                <SquareMinus size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="ghost icon-button file-tree-root-action"
                onClick={() => setSearchOpen(true)}
                aria-label={t('fileTreeMenu.search')}
                title={t('fileTreeMenu.search')}
              >
                <Search size={14} aria-hidden />
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        className="file-tree-list"
        onClick={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          setSelectedNodePath('');
          setSelectedNodeType('folder');
        }}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          void showContextMenu(event, '', true);
        }}
      >
        {searchOpen && search.isSearchMode ? (
          <WorkspaceFileSearchResults
            search={search}
            onOpenFile={(path, location) => onOpenFile?.(path, location)}
          />
        ) : showLoading ? (
          <div className="file-tree-skeleton">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                className="file-tree-skeleton-row"
                key={`file-tree-skeleton-${index}`}
                style={{ width: `${68 + index * 3}%` }}
              />
            ))}
          </div>
        ) : (
          <>
            {newFolderParent === '' && renderInlineNewInput('folder', 1)}
            {newFileParent === '' && renderInlineNewInput('file', 1)}
            {nodes.map((node) => renderNode(node, 1))}
          </>
        )}
      </div>
      {contextMenu ? (
        <ProductContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={contextMenuHeader ?? undefined}
          items={fileTreeContextMenuItems}
          itemRole="button"
          onClose={closeContextMenu}
        />
      ) : null}
      {previewPath && previewAnchor
        ? createPortal(
            <FilePreviewPopover
              path={previewPath}
              absolutePath={resolvePath(previewPath)}
              content={previewContent}
              truncated={previewTruncated}
              previewKind={previewKind}
              imageSrc={previewImageSrc}
              selection={previewSelection}
              onSelectLine={handleSelectLine}
              onLineMouseDown={handleLineMouseDown}
              onLineMouseEnter={handleLineMouseEnter}
              onLineMouseUp={handleLineMouseUp}
              onClearSelection={() => setPreviewSelection(null)}
              onAddSelection={handleAddSelection}
              onClose={closePreview}
              selectionHints={selectionHints}
              style={{
                position: 'fixed',
                top: previewAnchor.top,
                left: previewAnchor.left,
                width: 640,
                maxHeight: previewAnchor.height,
                ['--file-preview-arrow-top' as string]: `${previewAnchor.arrowTop}px`,
              }}
              isLoading={effectivePreviewLoading}
              error={effectivePreviewError}
            />,
            document.body
          )
        : null}
      {dragOverlay
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[10060] rounded-md border border-border/80 bg-popover/95 px-2 py-1 text-xs text-popover-foreground shadow-xl backdrop-blur-sm"
              style={{
                left: dragOverlay.x + 12,
                top: dragOverlay.y + 12,
              }}
            >
              {dragOverlay.payload.kind === 'directory' ? 'Folder: ' : 'File: '}
              {dragOverlay.payload.fileName}
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}
