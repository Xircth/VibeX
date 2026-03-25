import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Plus,
  SquareMinus,
  Trash2,
  TreePine,
} from "lucide-react";
import FileIcon from "../FileIcon";
import { desktopApi, fileTreeApi } from "../../lib/api";
import type { DirectoryChildrenResponse } from "../../lib/api";
import { languageFromPath } from "../../utils/syntax";
import {
  FILE_REFERENCE_DRAG_MIME,
  serializeFileReferencePayload,
} from "../../utils/fileReferences";
import { FilePreviewPopover } from "./FilePreviewPopover";
import type { FileTreeNode, FileOpenLocation } from "./file-tree-types";
import { EMPTY_DIRECTORIES, EMPTY_SET } from "./file-tree-constants";
import { isSpecialDirectoryPath, buildTree, isImagePath, resolveWorkspaceRootLabel } from "./file-tree-utils";
import "@/styles/file-tree.css";

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
};

const FILE_TREE_LABELS = {
  newFile: "\u65b0\u5efa\u6587\u4ef6",
  newFolder: "\u65b0\u5efa\u6587\u4ef6\u5939",
  duplicate: "\u590d\u5236",
  copyRelativePath: "\u590d\u5236\u76f8\u5bf9\u8def\u5f84",
  copyAbsolutePath: "\u590d\u5236\u7edd\u5bf9\u8def\u5f84",
  openInFileManager: "\u5728\u6587\u4ef6\u7ba1\u7406\u5668\u4e2d\u6253\u5f00",
  delete: "\u5220\u9664",
} as const;

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
}: FileTreePanelProps) {
  const directoryEntries = directories ?? EMPTY_DIRECTORIES;
  const ignoredFileEntries = gitignoredFiles ?? EMPTY_SET;
  const ignoredDirectoryEntries = gitignoredDirectories ?? EMPTY_SET;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{
    top: number;
    left: number;
    arrowTop: number;
    height: number;
  } | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
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
  const [selectedNodeType, setSelectedNodeType] = useState<"file" | "folder" | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    relativePath: string;
    isFolder: boolean;
  } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const [lazyFiles, setLazyFiles] = useState<Set<string>>(new Set());
  const [lazyDirectories, setLazyDirectories] = useState<Set<string>>(new Set());
  const [lazyGitignoredFiles, setLazyGitignoredFiles] = useState<Set<string>>(new Set());
  const [lazyGitignoredDirectories, setLazyGitignoredDirectories] = useState<Set<string>>(new Set());
  const [lazyLoadableDirectories, setLazyLoadableDirectories] = useState<Set<string>>(new Set());
  const [loadedLazyDirectories, setLoadedLazyDirectories] = useState<Set<string>>(new Set());
  const [loadingLazyDirectories, setLoadingLazyDirectories] = useState<Set<string>>(new Set());
  const [lazyDirectoryLoadErrors, setLazyDirectoryLoadErrors] = useState<Map<string, string>>(
    new Map(),
  );
  const loadedLazyDirectoriesRef = useRef<Set<string>>(new Set());
  const loadingLazyDirectoriesRef = useRef<Set<string>>(new Set());

  const workspaceRootLabel = useMemo(
    () => resolveWorkspaceRootLabel(workspacePath, workspaceName),
    [workspaceName, workspacePath],
  );
  const previewKind = useMemo(
    () => (previewPath && isImagePath(previewPath) ? "image" : "text"),
    [previewPath],
  );
  const mergedFiles = useMemo(() => {
    const next = new Set<string>(files);
    lazyFiles.forEach((path) => next.add(path));
    return Array.from(next);
  }, [files, lazyFiles]);
  const mergedDirectories = useMemo(() => {
    const next = new Set<string>(directoryEntries);
    lazyDirectories.forEach((path) => next.add(path));
    return Array.from(next);
  }, [directoryEntries, lazyDirectories]);
  const mergedGitignoredFiles = useMemo(() => {
    const next = new Set<string>(ignoredFileEntries);
    lazyGitignoredFiles.forEach((path) => next.add(path));
    return next;
  }, [ignoredFileEntries, lazyGitignoredFiles]);
  const mergedGitignoredDirectories = useMemo(() => {
    const next = new Set<string>(ignoredDirectoryEntries);
    lazyGitignoredDirectories.forEach((path) => next.add(path));
    return next;
  }, [ignoredDirectoryEntries, lazyGitignoredDirectories]);
  const seededLazyLoadableDirectories = useMemo(() => {
    const result = new Set<string>();
    mergedDirectories.forEach((path) => {
      if (isSpecialDirectoryPath(path)) {
        result.add(path);
      }
    });
    return result;
  }, [mergedDirectories]);
  const effectiveLazyLoadableDirectories = useMemo(() => {
    const result = new Set(seededLazyLoadableDirectories);
    lazyLoadableDirectories.forEach((path) => result.add(path));
    return result;
  }, [seededLazyLoadableDirectories, lazyLoadableDirectories]);
  const showLoading = isLoading && mergedFiles.length === 0;

  const gitStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    if (gitStatusFiles) {
      for (const entry of gitStatusFiles) {
        map.set(entry.path, entry.status);
      }
    }
    return map;
  }, [gitStatusFiles]);

  const { nodes, folderPaths } = useMemo(
    () => buildTree(
      mergedFiles,
      mergedDirectories,
      effectiveLazyLoadableDirectories,
    ),
    [
      effectiveLazyLoadableDirectories,
      mergedDirectories,
      mergedFiles,
    ],
  );

  const folderGitStatusMap = useMemo(() => {
    if (gitStatusMap.size === 0) {
      return new Map<string, string>();
    }
    const priority: Record<string, number> = { D: 4, A: 3, M: 2, R: 1, T: 0 };
    const map = new Map<string, string>();
    const computeForNode = (node: FileTreeNode): string | null => {
      if (node.type === "file") {
        return gitStatusMap.get(node.path) ?? null;
      }
      let highest: string | null = null;
      let highestPri = -1;
      for (const child of node.children) {
        const childStatus = computeForNode(child);
        if (childStatus && (priority[childStatus] ?? -1) > highestPri) {
          highest = childStatus;
          highestPri = priority[childStatus] ?? -1;
        }
      }
      if (highest) {
        map.set(node.path, highest);
      }
      return highest;
    };
    for (const node of nodes) {
      computeForNode(node);
    }
    return map;
  }, [nodes, gitStatusMap]);

  const visibleFolderPaths = folderPaths;
  const hasFolders = visibleFolderPaths.size > 0;
  const allVisibleExpanded =
    hasFolders && Array.from(visibleFolderPaths).every((path) => expandedFolders.has(path));
  const isRootVisibleExpanded = rootExpanded;

  useEffect(() => {
    setExpandedFolders((prev) => {
      const next = new Set<string>();
      prev.forEach((path) => {
        if (folderPaths.has(path)) {
          next.add(path);
        }
      });
      return next;
    });
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
    setPreviewContent("");
    setPreviewTruncated(false);
    setPreviewError(null);
    setPreviewLoading(false);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
    setContextMenu(null);
    setLazyFiles(new Set());
    setLazyDirectories(new Set());
    setLazyGitignoredFiles(new Set());
    setLazyGitignoredDirectories(new Set());
    setLazyLoadableDirectories(new Set());
    setLoadedLazyDirectories(new Set());
    setLoadingLazyDirectories(new Set());
    setLazyDirectoryLoadErrors(new Map());
    setNewFileParent(null);
    setNewFileName("");
    setNewFolderParent(null);
    setNewFolderName("");
    setRootExpanded(true);
    loadedLazyDirectoriesRef.current = new Set();
    loadingLazyDirectoriesRef.current = new Set();
  }, [workspacePath]);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    setPreviewAnchor(null);
    setPreviewSelection(null);
    setPreviewContent("");
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
        const response: DirectoryChildrenResponse = await fileTreeApi.listDirectoryChildren(
          workspacePath,
          path,
        );
        const nextFiles = Array.isArray(response.files) ? response.files : [];
        const nextDirectories = Array.isArray(response.directories) ? response.directories : [];
        const nextGitignoredFiles = Array.isArray(response.gitignored_files)
          ? response.gitignored_files
          : [];
        const nextGitignoredDirectories = Array.isArray(response.gitignored_directories)
          ? response.gitignored_directories
          : [];

        setLazyFiles((prev) => {
          const next = new Set(prev);
          nextFiles.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyDirectories((prev) => {
          const next = new Set(prev);
          nextDirectories.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyLoadableDirectories((prev) => {
          const next = new Set(prev);
          nextDirectories.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyGitignoredFiles((prev) => {
          const next = new Set(prev);
          nextGitignoredFiles.forEach((entry) => next.add(entry));
          return next;
        });
        setLazyGitignoredDirectories((prev) => {
          const next = new Set(prev);
          nextGitignoredDirectories.forEach((entry) => next.add(entry));
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
    [workspacePath],
  );

  useEffect(() => {
    if (!previewPath) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewPath, closePreview]);

  const toggleAllFolders = () => {
    if (!hasFolders) {
      return;
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (allVisibleExpanded) {
        visibleFolderPaths.forEach((path) => next.delete(path));
      } else {
        visibleFolderPaths.forEach((path) => next.add(path));
      }
      return next;
    });
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const resolvePath = useCallback(
    (relativePath: string) => {
      const usesWindowsSeparator = workspacePath.includes("\\");
      const separator = usesWindowsSeparator ? "\\" : "/";
      const base = workspacePath.replace(/[\\/]+$/, "");
      const normalizedRelative = usesWindowsSeparator
        ? relativePath.replaceAll("/", "\\")
        : relativePath;
      return `${base}${separator}${normalizedRelative}`;
    },
    [workspacePath],
  );

  const previewImageSrc = useMemo(() => {
    if (!previewPath || previewKind !== "image") {
      return null;
    }
    try {
      return convertFileSrc(resolvePath(previewPath));
    } catch {
      return null;
    }
  }, [previewPath, previewKind, resolvePath]);

  const openPreview = useCallback((path: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const estimatedWidth = 640;
    const estimatedHeight = 520;
    const padding = 16;
    const maxHeight = Math.min(estimatedHeight, window.innerHeight - padding * 2);
    const left = Math.min(
      Math.max(padding, rect.left - estimatedWidth - padding),
      Math.max(padding, window.innerWidth - estimatedWidth - padding),
    );
    const top = Math.min(
      Math.max(padding, rect.top - maxHeight * 0.35),
      Math.max(padding, window.innerHeight - maxHeight - padding),
    );
    const arrowTop = Math.min(
      Math.max(16, rect.top + rect.height / 2 - top),
      Math.max(16, maxHeight - 16),
    );
    setPreviewPath(path);
    setPreviewAnchor({ top, left, arrowTop, height: maxHeight });
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
    if (previewKind === "image") {
      setPreviewContent("");
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
    fileTreeApi.readFileWithTruncation(absolutePath)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPreviewContent(response.content ?? "");
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
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [isDragSelecting]);

  const selectRangeFromAnchor = useCallback((anchor: number, index: number) => {
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    setPreviewSelection({ start, end });
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
    [previewSelection, selectRangeFromAnchor],
  );

  const handleLineMouseDown = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (previewKind !== "text" || event.button !== 0) {
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
    [previewKind, previewSelection, selectRangeFromAnchor],
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
    [isDragSelecting, selectRangeFromAnchor],
  );

  const handleLineMouseUp = useCallback(() => {
    if (!isDragSelecting) {
      return;
    }
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
  }, [isDragSelecting]);

  const selectionHints = useMemo(
    () =>
      previewKind === "text"
        ? ["Shift+点击选择范围", "拖拽选择多行"]
        : [],
    [previewKind],
  );

  const handleAddSelection = useCallback(() => {
    if (previewKind !== "text" || !previewPath || !previewSelection || !onInsertText) {
      return;
    }
    const lines = previewContent.split("\n");
    const selected = lines.slice(previewSelection.start, previewSelection.end + 1);
    const language = languageFromPath(previewPath);
    const fence = language ? `\`\`\`${language}` : "```";
    const start = previewSelection.start + 1;
    const end = previewSelection.end + 1;
    const rangeLabel = start === end ? `L${start}` : `L${start}-L${end}`;
    const snippet = `${previewPath}:${rangeLabel}\n${fence}\n${selected.join("\n")}\n\`\`\``;
    onInsertText(snippet);
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
          relativePath ? resolvePath(relativePath) : workspacePath
        );
      } catch {
        // clipboard write is not critical
      }
    },
    [resolvePath, workspacePath],
  );

  const copyRelativePath = useCallback(async (relativePath: string) => {
    try {
      await navigator.clipboard.writeText(relativePath || ".");
    } catch {
      // clipboard write is not critical
    }
  }, []);

  const openInFileManager = useCallback(
    async (relativePath: string) => {
      try {
        const absolutePath = relativePath ? resolvePath(relativePath) : workspacePath;
        await desktopApi.revealInFileManager(absolutePath);
      } catch (error) {
        console.error("Failed to reveal path in file manager:", error);
      }
    },
    [resolvePath, workspacePath],
  );

  const trashItem = useCallback(
    async (relativePath: string, isFolder: boolean) => {
      const name = relativePath.split("/").pop() ?? relativePath;
      const confirmMessage = isFolder
        ? `确定要删除文件夹 "${name}" 吗？`
        : `确定要删除文件 "${name}" 吗？`;

      const confirmed = await confirm(confirmMessage, {
        title: "删除",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      });

      if (!confirmed) {
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
        // TODO: surface error to user via toast/notification
        console.error('Failed to trash item:', e);
      }
    },
    [resolvePath, onRefreshFiles, selectedNodePath],
  );

  const duplicateItem = useCallback(
    async (relativePath: string) => {
      try {
        const absolutePath = resolvePath(relativePath);
        await fileTreeApi.copyItem(absolutePath);
        onRefreshFiles?.();
      } catch (e) {
        // TODO: surface error to user via toast/notification
        console.error('Failed to duplicate item:', e);
      }
    },
    [resolvePath, onRefreshFiles],
  );

  const openNewFilePrompt = useCallback(
    (parentFolder: string) => {
      setNewFolderParent(null);
      setNewFolderName("");
      setNewFileParent(parentFolder);
      setNewFileName("");
      if (parentFolder) {
        setExpandedFolders((prev) => {
          if (prev.has(parentFolder)) return prev;
          const next = new Set(prev);
          next.add(parentFolder);
          return next;
        });
      }
      requestAnimationFrame(() => {
        newFileInputRef.current?.focus();
      });
    },
    [],
  );

  const confirmNewFile = useCallback(async () => {
    if (newFileParent === null) return;
    const name = newFileName.trim() || "untitled";
    const relativePath = newFileParent ? `${newFileParent}/${name}` : name;
    try {
      const absolutePath = resolvePath(relativePath);
      await fileTreeApi.saveFile(absolutePath, "");
      onRefreshFiles?.();
    } catch (e) {
      // TODO: surface error to user via toast/notification
      console.error('Failed to create file:', e);
    }
    setNewFileParent(null);
    setNewFileName("");
  }, [newFileName, newFileParent, resolvePath, onRefreshFiles]);

  const cancelNewFile = useCallback(() => {
    setNewFileParent(null);
    setNewFileName("");
  }, []);

  const openNewFolderPrompt = useCallback(
    (parentFolder: string) => {
      setNewFileParent(null);
      setNewFileName("");
      setNewFolderParent(parentFolder);
      setNewFolderName("");
      if (parentFolder) {
        setExpandedFolders((prev) => {
          if (prev.has(parentFolder)) return prev;
          const next = new Set(prev);
          next.add(parentFolder);
          return next;
        });
      }
      requestAnimationFrame(() => {
        newFolderInputRef.current?.focus();
      });
    },
    [],
  );

  const confirmNewFolder = useCallback(async () => {
    if (newFolderParent === null) return;
    const name = newFolderName.trim() || "新建文件夹";
    const relativePath = newFolderParent ? `${newFolderParent}/${name}` : name;
    try {
      const absolutePath = resolvePath(relativePath);
      await fileTreeApi.createDirectory(absolutePath);
      onRefreshFiles?.();
    } catch (e) {
      // TODO: surface error to user via toast/notification
      console.error('Failed to create folder:', e);
    }
    setNewFolderParent(null);
    setNewFolderName("");
  }, [newFolderName, newFolderParent, resolvePath, onRefreshFiles]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParent(null);
    setNewFolderName("");
  }, []);

  const resolveParentFolderForNode = useCallback(
    (relativePath: string | null, nodeType: "file" | "folder" | null) => {
      if (!relativePath) {
        return "";
      }
      if (nodeType === "folder") {
        return relativePath;
      }
      const separatorIndex = relativePath.lastIndexOf("/");
      return separatorIndex >= 0 ? relativePath.slice(0, separatorIndex) : "";
    },
    [],
  );

  const selectedParentFolder = useMemo(
    () => resolveParentFolderForNode(selectedNodePath, selectedNodeType),
    [resolveParentFolderForNode, selectedNodePath, selectedNodeType],
  );
  const canTrashSelectedNode =
    selectedNodeType !== null && selectedNodePath !== null && selectedNodePath.length > 0;
  const contextMenuParentFolder = useMemo(
    () =>
      resolveParentFolderForNode(
        contextMenu?.relativePath ?? "",
        contextMenu?.isFolder ? "folder" : "file",
      ),
    [contextMenu?.isFolder, contextMenu?.relativePath, resolveParentFolderForNode],
  );

  /*
  const showContextMenu = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, relativePath: string, isFolder: boolean) => {
      event.preventDefault();
      event.stopPropagation();

      const parentFolder = resolveParentFolderForNode(relativePath, isFolder ? "folder" : "file");

      const menuItems = [
        await MenuItem.new({
          text: "新建文件",
          action: () => {
            openNewFilePrompt(parentFolder);
          },
        }),
        await MenuItem.new({
          text: "新建文件夹",
          action: () => {
            openNewFolderPrompt(parentFolder);
          },
        }),
        await MenuItem.new({
          text: "复制",
          action: async () => {
            await duplicateItem(relativePath);
          },
        }),
        await MenuItem.new({
          text: "复制路径",
          action: async () => {
            await copyPath(relativePath);
          },
        }),
        await MenuItem.new({
          text: "在文件管理器中打开",
          action: async () => {
            const absolutePath = resolvePath(relativePath);
            try {
              const { Command } = await import("@tauri-apps/plugin-shell");
              const isWindows = absolutePath.includes("\\");
              if (isWindows) {
                const normalized = absolutePath.replaceAll("/", "\\");
                await Command.create("cmd", ["/c", "explorer", "/select,", normalized]).execute();
              } else {
                const parent = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
                await Command.create("open", [parent]).execute();
              }
            } catch {
              // shell command failed, not critical
            }
          },
        }),
        await MenuItem.new({
          text: "删除",
          action: async () => {
            await trashItem(relativePath, isFolder);
          },
        }),
      ];

      const menu = await Menu.new({ items: menuItems });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [
      resolvePath,
      copyPath,
      trashItem,
      duplicateItem,
      openNewFilePrompt,
      openNewFolderPrompt,
      resolveParentFolderForNode,
    ],
  );
  */
  const showContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>, relativePath: string, isFolder: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        relativePath,
        isFolder,
      });
    },
    [],
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
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };

    const handleWindowChange = () => {
      closeContextMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [closeContextMenu, contextMenu]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedNodePath || !selectedNodeType) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      if (panelRef.current && !panelRef.current.contains(target)) {
        return;
      }

      const isMac = navigator.platform.includes("Mac");
      const primaryModifier = isMac ? event.metaKey : event.ctrlKey;

      if (primaryModifier && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        void trashItem(selectedNodePath, selectedNodeType === "folder");
        return;
      }

      if (primaryModifier && !event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copyAbsolutePath(selectedNodePath);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNodePath, selectedNodeType, trashItem, copyAbsolutePath]);

  const renderInlineNewInput = (type: "file" | "folder", depth: number) => {
    const isFile = type === "file";
    const inputRef = isFile ? newFileInputRef : newFolderInputRef;
    const name = isFile ? newFileName : newFolderName;
    const setName = isFile ? setNewFileName : setNewFolderName;
    const defaultName = isFile ? "untitled" : "新建文件夹";
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
              filePath={isFile ? "untitled" : "folder"}
              isFolder={!isFile}
              isOpen={false}
            />
          </span>
          <input
            ref={inputRef}
            className="file-tree-inline-input"
            value={name}
            placeholder={defaultName}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                doCancel();
              }
              if (e.key === "Enter") {
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
    const isFolder = node.type === "folder";
    const isLazyFolder = isFolder && (node.isLazyLoadable ?? false);
    const hasChildren = isFolder && node.children.length > 0;
    const canExpand = isFolder && (hasChildren || isLazyFolder);
    const isExpanded = canExpand && expandedFolders.has(node.path);
    const isLazyLoading = isLazyFolder && loadingLazyDirectories.has(node.path);
    const lazyLoadError = isLazyFolder ? lazyDirectoryLoadErrors.get(node.path) ?? null : null;
    const fileGitStatus = isFolder
      ? folderGitStatusMap.get(node.path) ?? null
      : gitStatusMap.get(node.path) ?? null;
    const gitStatusClass = fileGitStatus
      ? ` git-${fileGitStatus.toLowerCase()}`
      : "";
    const isGitignored = isFolder
      ? mergedGitignoredDirectories.has(node.path)
      : mergedGitignoredFiles.has(node.path);
    return (
      <div key={node.path}>
        <div className="file-tree-row-wrap">
          <button
            type="button"
            draggable
            className={`file-tree-row${isFolder ? " is-folder" : " is-file"}${isGitignored ? " is-gitignored" : ""}${selectedNodePath === node.path ? " is-selected" : ""}`}
            style={{ paddingLeft: `${depth * 10}px` }}
            onClick={(event) => {
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
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                FILE_REFERENCE_DRAG_MIME,
                serializeFileReferencePayload({
                  fileName: node.name,
                  relativePath: node.path,
                  kind: isFolder ? "directory" : "file",
                }),
              );
              event.dataTransfer.setData("text/plain", node.path);
            }}
          >
            {isFolder && canExpand ? (
              <span className={`file-tree-chevron${isExpanded ? " is-open" : ""}`}>
                ›
              </span>
            ) : (
              <span className="file-tree-spacer" aria-hidden />
            )}
            <span className="file-tree-icon" aria-hidden>
              <FileIcon filePath={node.name} isFolder={isFolder} isOpen={isExpanded} />
            </span>
            <span className={`file-tree-name${gitStatusClass}`}>{node.name}</span>
          </button>
          {onInsertText && (
            <button
              type="button"
              className={`ghost icon-button file-tree-action${selectedNodePath === node.path ? " is-visible" : ""}`}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                const mentionText = `${node.path}${node.type === "file" ? " " : ""}`;
                onInsertText(mentionText);
              }}
              aria-label={`引用 ${node.name}`}
              title="引用到聊天"
            >
              <Plus size={10} aria-hidden />
            </button>
          )}
        </div>
        {isFolder && isExpanded && (hasChildren || newFolderParent === node.path || newFileParent === node.path) && (
          <div className="file-tree-children">
            {newFolderParent === node.path && renderInlineNewInput("folder", depth + 1)}
            {newFileParent === node.path && renderInlineNewInput("file", depth + 1)}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
        {isLazyFolder && isExpanded && node.children.length === 0 && (
          <div className="file-tree-children">
            {isLazyLoading ? (
              <div className="file-tree-lazy-state">加载中...</div>
            ) : lazyLoadError ? (
              <button
                type="button"
                className="file-tree-lazy-retry"
                onClick={() => void loadLazyDirectoryChildren(node.path)}
                title={lazyLoadError}
              >
                加载失败，点击重试
              </button>
            ) : (
              <div className="file-tree-lazy-state">无文件</div>
            )}
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
              className={`file-tree-row is-folder is-root${selectedNodePath === "" ? " is-selected" : ""}`}
              onClick={() => {
                setSelectedNodePath("");
                setSelectedNodeType("folder");
                setRootExpanded((prev) => !prev);
              }}
              onContextMenu={(event) => {
                setSelectedNodePath("");
                setSelectedNodeType("folder");
                void showContextMenu(event, "", true);
              }}
            >
              <span className={`file-tree-chevron${isRootVisibleExpanded ? " is-open" : ""}`}>
                ›
              </span>
              <span className="file-tree-icon file-tree-icon-root-special" aria-hidden>
                <TreePine size={13} />
              </span>
              <span className="file-tree-name">{workspaceRootLabel}</span>
            </button>
          </div>
          <div className="file-tree-root-actions">
            <button
              type="button"
              className="ghost icon-button file-tree-root-action"
              onClick={() => openNewFilePrompt(selectedParentFolder)}
              aria-label="新建文件"
              title="新建文件"
            >
              <FilePlus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ghost icon-button file-tree-root-action"
              onClick={() => openNewFolderPrompt(selectedParentFolder)}
              aria-label="新建文件夹"
              title="新建文件夹"
            >
              <FolderPlus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ghost icon-button file-tree-root-action"
              onClick={toggleAllFolders}
              disabled={!hasFolders}
              aria-label={allVisibleExpanded ? "折叠所有文件夹" : "展开所有文件夹"}
              title={allVisibleExpanded ? "折叠所有文件夹" : "展开所有文件夹"}
            >
              <SquareMinus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ghost icon-button file-tree-root-action file-tree-root-action-danger"
              onClick={() => {
                if (!canTrashSelectedNode || !selectedNodePath || !selectedNodeType) {
                  return;
                }
                void trashItem(selectedNodePath, selectedNodeType === "folder");
              }}
              disabled={!canTrashSelectedNode}
              aria-label="删除"
              title="删除"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>
      <div className="file-tree-list">
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
            {newFolderParent === "" && renderInlineNewInput("folder", 1)}
            {newFileParent === "" && renderInlineNewInput("file", 1)}
            {nodes.length === 0 && newFileParent !== "" && newFolderParent !== "" && (
              <div className="file-tree-empty">
                无文件
              </div>
            )}
            {nodes.map((node) => renderNode(node, 1))}
          </>
        )}
      </div>
      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="fixed z-[10050] min-w-[220px] overflow-hidden rounded-xl border border-border/80 bg-popover/95 p-1.5 text-popover-foreground shadow-2xl backdrop-blur-md"
              style={{
                top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 260)),
                left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 240)),
              }}
            >
              <div className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">
                <div className="truncate font-medium text-foreground">
                  {contextMenu.relativePath || workspaceRootLabel}
                </div>
                <div className="truncate">
                  {contextMenu.relativePath ? contextMenu.relativePath : "."}
                </div>
              </div>

              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  openNewFilePrompt(contextMenuParentFolder);
                }}
              >
                <FilePlus className="h-4 w-4" />
                <span>{FILE_TREE_LABELS.newFile}</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  openNewFolderPrompt(contextMenuParentFolder);
                }}
              >
                <FolderPlus className="h-4 w-4" />
                <span>{FILE_TREE_LABELS.newFolder}</span>
              </button>
              {contextMenu.relativePath ? (
                <>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                    onClick={() => {
                      closeContextMenu();
                      void duplicateItem(contextMenu.relativePath);
                    }}
                  >
                    <Copy className="h-4 w-4" />
                    <span>{FILE_TREE_LABELS.duplicate}</span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                    onClick={() => {
                      closeContextMenu();
                      void copyRelativePath(contextMenu.relativePath);
                    }}
                  >
                    <Copy className="h-4 w-4" />
                    <span>{FILE_TREE_LABELS.copyRelativePath}</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  void copyAbsolutePath(contextMenu.relativePath);
                }}
              >
                <Copy className="h-4 w-4" />
                <span>{FILE_TREE_LABELS.copyAbsolutePath}</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  closeContextMenu();
                  void openInFileManager(contextMenu.relativePath);
                }}
              >
                <FolderOpen className="h-4 w-4" />
                <span>{FILE_TREE_LABELS.openInFileManager}</span>
              </button>
              {contextMenu.relativePath ? (
                <button
                  type="button"
                  className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                  onClick={() => {
                    closeContextMenu();
                    void trashItem(contextMenu.relativePath, contextMenu.isFolder);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>{FILE_TREE_LABELS.delete}</span>
                </button>
              ) : null}
            </div>,
            document.body,
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
                position: "fixed",
                top: previewAnchor.top,
                left: previewAnchor.left,
                width: 640,
                maxHeight: previewAnchor.height,
                ["--file-preview-arrow-top" as string]: `${previewAnchor.arrowTop}px`,
              }}
              isLoading={previewLoading}
              error={previewError}
            />,
            document.body,
          )
        : null}
    </aside>
  );
}
