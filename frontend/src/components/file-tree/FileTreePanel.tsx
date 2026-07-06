import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  FilePlus,
  FolderPlus,
  Plus,
  RefreshCw,
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
import type { FileTreeNode, FileOpenLocation } from './file-tree-types';
import { EMPTY_DIRECTORIES, EMPTY_SET } from './file-tree-constants';
import {
  deriveFileTreeContextMenuHeader,
  deriveFileTreeContextMenuPosition,
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
  getAreAllVisibleFileTreeFoldersExpanded,
  normalizeDirectoryChildrenResponse,
  pruneExpandedFileTreeFolders,
  resolveFileTreeAbsolutePath,
  resolveWorkspaceRootLabel,
  toggleAllFileTreeFolders,
  toggleFileTreeFolder,
} from './file-tree-utils';
import { ConfirmDialog } from '@/components/dialogs';
import '@/styles/file-tree.css';
import type { FileTreeRevealTarget } from '@/stores/useFileTreeStore';

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
  refreshToken = 0,
  lazyLoadAllDirectories = false,
  revealTarget = null,
}: FileTreePanelProps) {
  const { t } = useTranslation(['panels', 'common']);
  const directoryEntries = directories ?? EMPTY_DIRECTORIES;
  const ignoredFileEntries = gitignoredFiles ?? EMPTY_SET;
  const ignoredDirectoryEntries = gitignoredDirectories ?? EMPTY_SET;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );
  const [rootExpanded, setRootExpanded] = useState(true);
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
  const [copySubmenuOpen, setCopySubmenuOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
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
  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const [lazyFiles, setLazyFiles] = useState<Set<string>>(new Set());
  const [lazyDirectories, setLazyDirectories] = useState<Set<string>>(
    new Set()
  );
  const [lazyGitignoredFiles, setLazyGitignoredFiles] = useState<Set<string>>(
    new Set()
  );
  const [lazyGitignoredDirectories, setLazyGitignoredDirectories] = useState<
    Set<string>
  >(new Set());
  const [lazyLoadableDirectories, setLazyLoadableDirectories] = useState<
    Set<string>
  >(new Set());
  const [loadedLazyDirectories, setLoadedLazyDirectories] = useState<
    Set<string>
  >(new Set());
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
  const previousRefreshTokenRef = useRef(refreshToken);

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
        lazyFiles,
        lazyDirectories,
        lazyGitignoredFiles,
        lazyGitignoredDirectories,
        lazyLoadableDirectories,
        lazyLoadAllDirectories,
      }),
    [
      directoryEntries,
      files,
      ignoredDirectoryEntries,
      ignoredFileEntries,
      lazyDirectories,
      lazyFiles,
      lazyGitignoredDirectories,
      lazyGitignoredFiles,
      lazyLoadAllDirectories,
      lazyLoadableDirectories,
    ]
  );
  const showLoading = isLoading && mergedFiles.length === 0;

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
  const hasFolders = visibleFolderPaths.size > 0;
  const allVisibleExpanded = getAreAllVisibleFileTreeFoldersExpanded(
    visibleFolderPaths,
    expandedFolders
  );
  const isRootVisibleExpanded = rootExpanded;

  useEffect(() => {
    setExpandedFolders((prev) =>
      pruneExpandedFileTreeFolders(prev, folderPaths)
    );
  }, [folderPaths]);

  useEffect(() => {
    loadedLazyDirectoriesRef.current = loadedLazyDirectories;
  }, [loadedLazyDirectories]);

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
    setCopySubmenuOpen(false);
    setLazyFiles(new Set());
    setLazyDirectories(new Set());
    setLazyGitignoredFiles(new Set());
    setLazyGitignoredDirectories(new Set());
    setLazyLoadableDirectories(new Set());
    setLoadedLazyDirectories(new Set());
    setLoadingLazyDirectories(new Set());
    setLazyDirectoryLoadErrors(new Map());
    setNewFileParent(null);
    setNewFileName('');
    setNewFolderParent(null);
    setNewFolderName('');
    setRootExpanded(true);
    setDropTargetPath(null);
    setDragOverlay(null);
    dragCandidateRef.current = null;
    suppressClickPathRef.current = null;
    loadedLazyDirectoriesRef.current = new Set();
    loadingLazyDirectoriesRef.current = new Set();
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
    async (path: string) => {
      if (
        loadedLazyDirectoriesRef.current.has(path) ||
        loadingLazyDirectoriesRef.current.has(path)
      ) {
        return;
      }
      setLoadingLazyDirectories((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      setLazyDirectoryLoadErrors((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      try {
        const response = normalizeDirectoryChildrenResponse(
          await fileTreeApi.listDirectoryChildren(workspacePath, path)
        );

        setLazyFiles((prev) => {
          const next = new Set(prev);
          response.files.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyDirectories((prev) => {
          const next = new Set(prev);
          response.directories.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyLoadableDirectories((prev) => {
          const next = new Set(prev);
          response.directories.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyGitignoredFiles((prev) => {
          const next = new Set(prev);
          response.gitignoredFiles.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyGitignoredDirectories((prev) => {
          const next = new Set(prev);
          response.gitignoredDirectories.forEach((entry) => next.add(entry));
          return next;
        });
        setLoadedLazyDirectories((prev) => {
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLazyDirectoryLoadErrors((prev) => {
          const next = new Map(prev);
          next.set(path, message);
          return next;
        });
      } finally {
        setLoadingLazyDirectories((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [workspacePath]
  );

  useEffect(() => {
    if (previousRefreshTokenRef.current === refreshToken) {
      return;
    }
    previousRefreshTokenRef.current = refreshToken;

    const expandedLazyDirectories = Array.from(
      loadedLazyDirectoriesRef.current
    ).filter((path) => expandedFolders.has(path));

    setLazyFiles(new Set());
    setLazyDirectories(new Set());
    setLazyGitignoredFiles(new Set());
    setLazyGitignoredDirectories(new Set());
    setLazyLoadableDirectories(new Set());
    setLoadedLazyDirectories(new Set());
    setLoadingLazyDirectories(new Set());
    setLazyDirectoryLoadErrors(new Map());
    loadedLazyDirectoriesRef.current = new Set();
    loadingLazyDirectoriesRef.current = new Set();

    expandedLazyDirectories.forEach((path) => {
      void loadLazyDirectoryChildren(path);
    });
  }, [expandedFolders, loadLazyDirectoryChildren, refreshToken]);

  useEffect(() => {
    if (!revealTarget) {
      return;
    }

    setRootExpanded(true);
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
  }, [loadLazyDirectoryChildren, revealTarget]);

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

  const toggleAllFolders = () => {
    if (!hasFolders) {
      return;
    }
    setExpandedFolders((prev) =>
      toggleAllFileTreeFolders({
        expandedFolders: prev,
        visibleFolderPaths,
        allVisibleExpanded,
      })
    );
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

  const {
    loading: effectivePreviewLoading,
    error: effectivePreviewError,
  } = deriveFilePreviewDisplayState({
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
    setCopySubmenuOpen(false);
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

  const openNewFilePrompt = useCallback((parentFolder: string) => {
    setNewFolderParent(null);
    setNewFolderName('');
    setNewFileParent(parentFolder);
    setNewFileName('');
    setExpandedFolders((prev) =>
      ensureFileTreeParentFolderExpanded(prev, parentFolder)
    );
    requestAnimationFrame(() => {
      newFileInputRef.current?.focus();
    });
  }, []);

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
      onRefreshFiles?.();
    } catch (e) {
      console.error('Failed to create file:', e);
      toast.error(t('fileTreeMenu.createFileFailed'));
    }
    setNewFileParent(null);
    setNewFileName('');
  }, [newFileName, newFileParent, resolvePath, onRefreshFiles, t]);

  const cancelNewFile = useCallback(() => {
    setNewFileParent(null);
    setNewFileName('');
  }, []);

  const openNewFolderPrompt = useCallback((parentFolder: string) => {
    setNewFileParent(null);
    setNewFileName('');
    setNewFolderParent(parentFolder);
    setNewFolderName('');
    setExpandedFolders((prev) =>
      ensureFileTreeParentFolderExpanded(prev, parentFolder)
    );
    requestAnimationFrame(() => {
      newFolderInputRef.current?.focus();
    });
  }, []);

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
      onRefreshFiles?.();
    } catch (e) {
      console.error('Failed to create folder:', e);
      toast.error(t('fileTreeMenu.createFolderFailed'));
    }
    setNewFolderParent(null);
    setNewFolderName('');
  }, [newFolderName, newFolderParent, resolvePath, onRefreshFiles, t]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParent(null);
    setNewFolderName('');
  }, []);

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
      event: MouseEvent<HTMLButtonElement>,
      relativePath: string,
      isFolder: boolean
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setCopySubmenuOpen(false);
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        relativePath,
        isFolder,
      });
    },
    []
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return;
      }

      closeContextMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    const handleWindowChange = () => {
      closeContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [closeContextMenu, contextMenu]);

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

  const renderInlineNewInput = (type: 'file' | 'folder', depth: number) => {
    const isFile = type === 'file';
    const inputConfig = getFileTreeInlineNewInputConfig(type);
    const inputRef = isFile ? newFileInputRef : newFolderInputRef;
    const name = isFile ? newFileName : newFolderName;
    const setName = isFile ? setNewFileName : setNewFolderName;
    const doConfirm = isFile ? confirmNewFile : confirmNewFolder;
    const doCancel = isFile ? cancelNewFile : cancelNewFolder;

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
          <input
            ref={inputRef}
            className="file-tree-inline-input"
            value={name}
            placeholder={inputConfig.fallbackName}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                doCancel();
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                void doConfirm();
              }
            }}
            onBlur={() => {
              void doConfirm();
            }}
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
              aria-label={t('fileTreeMenu.referenceNode', { name: node.name })}
              title={t('fileTreeMenu.referenceToChat')}
            >
              <Plus size={10} aria-hidden />
            </button>
          )}
        </div>
        {isFolder &&
          isExpanded &&
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
        {isLazyFolder && isExpanded && node.children.length === 0 && (
          <div className="file-tree-children">
            {isLazyLoading ? (
              <div className="file-tree-lazy-state">
                {t('fileTreeMenu.loading')}
              </div>
            ) : lazyLoadError ? (
              <button
                type="button"
                className="file-tree-lazy-retry"
                onClick={() => void loadLazyDirectoryChildren(node.path)}
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
        <div className="file-tree-root-row">
          <div className="file-tree-root-wrap">
            <button
              type="button"
              className={`file-tree-row is-folder is-root${selectedNodePath === '' ? ' is-selected' : ''}${dropTargetPath === '' ? ' is-drop-target' : ''}`}
              data-file-tree-drop-path=""
              onClick={() => {
                if (suppressClickPathRef.current === '') {
                  suppressClickPathRef.current = null;
                  return;
                }
                setSelectedNodePath('');
                setSelectedNodeType('folder');
                setRootExpanded((prev) => !prev);
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
              <span
                className={`file-tree-chevron${isRootVisibleExpanded ? ' is-open' : ''}`}
              >
                {'>'}
              </span>
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
                allVisibleExpanded
                  ? t('fileTreeMenu.collapseAllFolders')
                  : t('fileTreeMenu.expandAllFolders')
              }
              title={
                allVisibleExpanded
                  ? t('fileTreeMenu.collapseAllFolders')
                  : t('fileTreeMenu.expandAllFolders')
              }
            >
              <SquareMinus size={14} aria-hidden />
            </button>
          </div>
        </div>
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
      >
        {showLoading ? (
          <div className="file-tree-skeleton">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                className="file-tree-skeleton-row"
                key={`file-tree-skeleton-${index}`}
                style={{ width: `${68 + index * 3}%` }}
              />
            ))}
          </div>
        ) : !isRootVisibleExpanded ? null : (
          <>
            {newFolderParent === '' && renderInlineNewInput('folder', 1)}
            {newFileParent === '' && renderInlineNewInput('file', 1)}
            {nodes.map((node) => renderNode(node, 1))}
          </>
        )}
      </div>
      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="fixed z-[10050] min-w-[220px] overflow-visible rounded-xl border border-border/80 bg-popover/95 p-1.5 text-popover-foreground shadow-2xl backdrop-blur-md"
              style={deriveFileTreeContextMenuPosition({
                x: contextMenu.x,
                y: contextMenu.y,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
              })}
            >
              <div className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">
                <div className="truncate font-medium text-foreground">
                  {contextMenuHeader?.title}
                </div>
                {contextMenuHeader?.subtitle ? (
                  <div className="truncate">{contextMenuHeader.subtitle}</div>
                ) : null}
              </div>

              <button
                type="button"
                className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  openNewFilePrompt(contextMenuParentFolder);
                }}
              >
                <span>{t('fileTreeMenu.newFile')}</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  openNewFolderPrompt(contextMenuParentFolder);
                }}
              >
                <span>{t('fileTreeMenu.newFolder')}</span>
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                  onMouseEnter={() => setCopySubmenuOpen(true)}
                  onFocus={() => setCopySubmenuOpen(true)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCopySubmenuOpen((prev) => !prev);
                  }}
                >
                  <span>{t('fileTreeMenu.copy')}</span>
                </button>
                {copySubmenuOpen ? (
                  <div className="absolute left-full top-0 z-10 ml-1 min-w-[220px] overflow-visible rounded-xl border border-border/80 bg-popover/95 p-1.5 text-popover-foreground shadow-2xl backdrop-blur-md">
                    {contextMenu.relativePath && !contextMenu.isFolder ? (
                      <button
                        type="button"
                        className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                        onClick={() => {
                          closeContextMenu();
                          void duplicateItem(contextMenu.relativePath);
                        }}
                      >
                        <span>{t('fileTreeMenu.duplicate')}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                      onClick={() => {
                        closeContextMenu();
                        void copyRelativePath(contextMenu.relativePath);
                      }}
                    >
                      <span>{t('fileTreeMenu.copyRelativePath')}</span>
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                      onClick={() => {
                        closeContextMenu();
                        void copyAbsolutePath(contextMenu.relativePath);
                      }}
                    >
                      <span>{t('fileTreeMenu.copyAbsolutePath')}</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  void openInFileManager(
                    contextMenu.relativePath,
                    contextMenu.isFolder
                  );
                }}
              >
                <span>{t('fileTreeMenu.openInFileManager')}</span>
              </button>
              {contextMenu.relativePath ? (
                <button
                  type="button"
                  className="mt-1 flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                  onClick={() => {
                    closeContextMenu();
                    void trashItem(
                      contextMenu.relativePath,
                      contextMenu.isFolder
                    );
                  }}
                >
                  <span>{t('common:delete')}</span>
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
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
