import type { FileTreeNode, FileTreeBuildNode } from './file-tree-types';
import type { DirectoryChildrenResponse } from '../../lib/api';
import { languageFromPath } from '../../utils/syntax';
import {
  SPECIAL_DEPENDENCY_DIRECTORIES,
  SPECIAL_BUILD_ARTIFACT_DIRECTORIES,
  imageExtensions,
} from './file-tree-constants';

export type NormalizedDirectoryChildrenResponse = {
  files: string[];
  directories: string[];
  gitignoredFiles: string[];
  gitignoredDirectories: string[];
};

export type FilePreviewSelection = {
  start: number;
  end: number;
};

export type FilePreviewKind = 'text' | 'image';

export type FilePreviewDisplayStateInput = {
  previewKind: FilePreviewKind;
  textLoading: boolean;
  textError: string | null;
  imageLoading: boolean;
  imageError: unknown;
};

export type FilePreviewImagePathInput = {
  previewKind: FilePreviewKind;
  previewPath: string | null;
  workspacePath: string;
};

export type FilePreviewInsertionTextInput = {
  previewKind: FilePreviewKind;
  path: string | null;
  content: string;
  selection: FilePreviewSelection | null;
};

export type FilePreviewAnchorInput = {
  targetRect: {
    left: number;
    top: number;
    height: number;
  };
  viewportWidth: number;
  viewportHeight: number;
};

export type FilePreviewAnchor = {
  top: number;
  left: number;
  arrowTop: number;
  height: number;
};

export type FileTreeContextMenuPositionInput = {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type FileTreeContextMenuPosition = {
  top: number;
  left: number;
};

export type FileTreeContextMenuHeader = {
  title: string;
  subtitle: string | null;
};

export type FileTreeKeyboardActionInput = {
  selectedNodePath: string | null;
  selectedNodeType: 'file' | 'folder' | null;
  isMac: boolean;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export type FileTreeKeyboardAction =
  | { type: 'delete' }
  | { type: 'copyAbsolutePath' };

export type FileTreeNodeViewStateInput = {
  node: FileTreeNode;
  expandedFolders: Set<string>;
  loadingLazyDirectories: Set<string>;
  lazyDirectoryLoadErrors: Map<string, string>;
  folderGitStatusMap: Map<string, string>;
  gitStatusMap: Map<string, string>;
  mergedGitignoredDirectories: Set<string>;
  mergedGitignoredFiles: Set<string>;
  selectedNodePath: string | null;
  dropTargetPath: string | null;
};

export type FileTreeNodeViewState = {
  isFolder: boolean;
  isLazyFolder: boolean;
  hasChildren: boolean;
  canExpand: boolean;
  isExpanded: boolean;
  isLazyLoading: boolean;
  lazyLoadError: string | null;
  fileGitStatus: string | null;
  gitStatusClass: string;
  isGitignored: boolean;
  isDropTarget: boolean;
  rowClassName: string;
};

export type ToggleAllFileTreeFoldersInput = {
  expandedFolders: Set<string>;
  visibleFolderPaths: Set<string>;
  allVisibleExpanded: boolean;
};

export type FileTreeGitStatusEntry = {
  path: string;
  status: string;
};

export type FileTreeInlineNewInputType = 'file' | 'folder';

export type FileTreeInlineNewInputConfig = {
  fallbackName: string;
  iconPath: string;
  isFolder: boolean;
};

const TEXT_PREVIEW_SELECTION_HINTS = [
  'Shift+\u70b9\u51fb\u9009\u62e9\u8303\u56f4',
  '\u62d6\u62fd\u9009\u62e9\u591a\u884c',
];

export type DeriveFileTreeEntriesInput = {
  files: string[];
  directories: string[];
  ignoredFiles: Set<string>;
  ignoredDirectories: Set<string>;
  lazyFiles: Set<string>;
  lazyDirectories: Set<string>;
  lazyGitignoredFiles: Set<string>;
  lazyGitignoredDirectories: Set<string>;
  lazyLoadableDirectories: Set<string>;
  lazyLoadAllDirectories: boolean;
};

export type DerivedFileTreeEntries = {
  mergedFiles: string[];
  mergedDirectories: string[];
  mergedGitignoredFiles: Set<string>;
  mergedGitignoredDirectories: Set<string>;
  effectiveLazyLoadableDirectories: Set<string>;
};

const GIT_STATUS_PRIORITY: Record<string, number> = {
  D: 4,
  A: 3,
  M: 2,
  R: 1,
  T: 0,
};

function stripWindowsExtendedPathPrefix(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/i, '')
    .replace(/^\/\?\//i, '')
    .replace(/^\\\?\\/i, '');
}

function isAbsolutePath(path: string): boolean {
  const normalizedPath = stripWindowsExtendedPathPrefix(path);
  return (
    /^[a-zA-Z]:[\\/]/.test(normalizedPath) ||
    /^[\\/]\?[\\/][a-zA-Z]:[\\/]/.test(normalizedPath) ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('\\\\')
  );
}

export function resolveFileTreeAbsolutePath(
  workspacePath: string,
  relativePath: string
) {
  const normalizedPath = stripWindowsExtendedPathPrefix(relativePath);
  if (isAbsolutePath(normalizedPath)) {
    return normalizedPath;
  }

  const usesWindowsSeparator = workspacePath.includes('\\');
  const separator = usesWindowsSeparator ? '\\' : '/';
  const base = workspacePath.replace(/[\\/]+$/, '');
  const normalizedRelative = usesWindowsSeparator
    ? normalizedPath.replaceAll('/', '\\')
    : normalizedPath;
  return `${base}${separator}${normalizedRelative}`;
}

export function normalizeDirectoryChildrenResponse(
  response: Partial<DirectoryChildrenResponse>
): NormalizedDirectoryChildrenResponse {
  return {
    files: Array.isArray(response.files) ? response.files : [],
    directories: Array.isArray(response.directories)
      ? response.directories
      : [],
    gitignoredFiles: Array.isArray(response.gitignored_files)
      ? response.gitignored_files
      : [],
    gitignoredDirectories: Array.isArray(response.gitignored_directories)
      ? response.gitignored_directories
      : [],
  };
}

export function buildFilePreviewSelectionSnippet({
  path,
  content,
  selection,
}: {
  path: string;
  content: string;
  selection: FilePreviewSelection;
}) {
  const lines = content.split('\n');
  const selected = lines.slice(selection.start, selection.end + 1);
  const language = languageFromPath(path);
  const fence = language ? `\`\`\`${language}` : '```';
  const start = selection.start + 1;
  const end = selection.end + 1;
  const rangeLabel = start === end ? `L${start}` : `L${start}-L${end}`;
  return `${path}:${rangeLabel}\n${fence}\n${selected.join('\n')}\n\`\`\``;
}

export function getFilePreviewSelectionHints(previewKind: FilePreviewKind) {
  return previewKind === 'text' ? TEXT_PREVIEW_SELECTION_HINTS : [];
}

export function getFilePreviewKind(path: string | null): FilePreviewKind {
  return path && isImagePath(path) ? 'image' : 'text';
}

export function getFilePreviewImagePath({
  previewKind,
  previewPath,
  workspacePath,
}: FilePreviewImagePathInput) {
  if (!previewPath || previewKind !== 'image') {
    return null;
  }

  return resolveFileTreeAbsolutePath(workspacePath, previewPath);
}

export function deriveFilePreviewDisplayState({
  previewKind,
  textLoading,
  textError,
  imageLoading,
  imageError,
}: FilePreviewDisplayStateInput) {
  if (previewKind === 'image') {
    return {
      loading: imageLoading,
      error:
        imageError instanceof Error
          ? imageError.message
          : ((imageError as string | null) ?? null),
    };
  }

  return {
    loading: textLoading,
    error: textError,
  };
}

export function deriveFilePreviewSelectionRange(
  anchor: number,
  index: number
): FilePreviewSelection {
  return {
    start: Math.min(anchor, index),
    end: Math.max(anchor, index),
  };
}

export function getFilePreviewInsertionText({
  previewKind,
  path,
  content,
  selection,
}: FilePreviewInsertionTextInput) {
  if (previewKind !== 'text' || !path || !selection) {
    return null;
  }

  return buildFilePreviewSelectionSnippet({
    path,
    content,
    selection,
  });
}

export function deriveFilePreviewAnchor({
  targetRect,
  viewportWidth,
  viewportHeight,
}: FilePreviewAnchorInput): FilePreviewAnchor {
  const estimatedWidth = 640;
  const estimatedHeight = 520;
  const padding = 16;
  const maxHeight = Math.min(estimatedHeight, viewportHeight - padding * 2);
  const left = Math.min(
    Math.max(padding, targetRect.left - estimatedWidth - padding),
    Math.max(padding, viewportWidth - estimatedWidth - padding)
  );
  const top = Math.min(
    Math.max(padding, targetRect.top - maxHeight * 0.35),
    Math.max(padding, viewportHeight - maxHeight - padding)
  );
  const arrowTop = Math.min(
    Math.max(padding, targetRect.top + targetRect.height / 2 - top),
    Math.max(padding, maxHeight - padding)
  );

  return {
    top,
    left,
    arrowTop,
    height: maxHeight,
  };
}

export function deriveFileTreeContextMenuPosition({
  x,
  y,
  viewportWidth,
  viewportHeight,
}: FileTreeContextMenuPositionInput): FileTreeContextMenuPosition {
  return {
    top: Math.max(12, Math.min(y, viewportHeight - 260)),
    left: Math.max(12, Math.min(x, viewportWidth - 240)),
  };
}

export function deriveFileTreeContextMenuHeader(
  relativePath: string,
  workspaceRootLabel: string
): FileTreeContextMenuHeader {
  if (!relativePath) {
    return {
      title: workspaceRootLabel,
      subtitle: null,
    };
  }

  return {
    title:
      relativePath
        .split('/')
        .filter(Boolean)
        .pop() ?? relativePath,
    subtitle: relativePath,
  };
}

export function deriveFileTreeKeyboardAction({
  selectedNodePath,
  selectedNodeType,
  isMac,
  key,
  ctrlKey,
  metaKey,
  shiftKey,
}: FileTreeKeyboardActionInput): FileTreeKeyboardAction | null {
  if (!selectedNodePath || !selectedNodeType) {
    return null;
  }

  const primaryModifier = isMac ? metaKey : ctrlKey;
  if (!primaryModifier) {
    return null;
  }

  if (key === 'Delete' || key === 'Backspace') {
    return { type: 'delete' };
  }

  if (!shiftKey && key.toLowerCase() === 'c') {
    return { type: 'copyAbsolutePath' };
  }

  return null;
}

export function deriveFileTreeNodeViewState({
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
}: FileTreeNodeViewStateInput): FileTreeNodeViewState {
  const isFolder = node.type === 'folder';
  const isLazyFolder = isFolder && (node.isLazyLoadable ?? false);
  const hasChildren = isFolder && node.children.length > 0;
  const canExpand = isFolder && (hasChildren || isLazyFolder);
  const isExpanded = canExpand && expandedFolders.has(node.path);
  const isLazyLoading = isLazyFolder && loadingLazyDirectories.has(node.path);
  const lazyLoadError = isLazyFolder
    ? (lazyDirectoryLoadErrors.get(node.path) ?? null)
    : null;
  const fileGitStatus = isFolder
    ? (folderGitStatusMap.get(node.path) ?? null)
    : (gitStatusMap.get(node.path) ?? null);
  const gitStatusClass = fileGitStatus
    ? ` git-${fileGitStatus.toLowerCase()}`
    : '';
  const isGitignored = isFolder
    ? mergedGitignoredDirectories.has(node.path)
    : mergedGitignoredFiles.has(node.path);
  const isDropTarget = isFolder && dropTargetPath === node.path;

  return {
    isFolder,
    isLazyFolder,
    hasChildren,
    canExpand,
    isExpanded,
    isLazyLoading,
    lazyLoadError,
    fileGitStatus,
    gitStatusClass,
    isGitignored,
    isDropTarget,
    rowClassName: `file-tree-row${isFolder ? ' is-folder' : ' is-file'}${
      isGitignored ? ' is-gitignored' : ''
    }${selectedNodePath === node.path ? ' is-selected' : ''}${
      isDropTarget ? ' is-drop-target' : ''
    }`,
  };
}

export function getFileTreeMentionText(
  path: string,
  nodeType: 'file' | 'folder'
) {
  return `${path}${nodeType === 'file' ? ' ' : ''}`;
}

export function pruneExpandedFileTreeFolders(
  expandedFolders: Set<string>,
  folderPaths: Set<string>
) {
  const next = new Set<string>();
  expandedFolders.forEach((path) => {
    if (folderPaths.has(path)) {
      next.add(path);
    }
  });
  return next;
}

export function getAreAllVisibleFileTreeFoldersExpanded(
  visibleFolderPaths: Set<string>,
  expandedFolders: Set<string>
) {
  return (
    visibleFolderPaths.size > 0 &&
    Array.from(visibleFolderPaths).every((path) => expandedFolders.has(path))
  );
}

export function toggleAllFileTreeFolders({
  expandedFolders,
  visibleFolderPaths,
  allVisibleExpanded,
}: ToggleAllFileTreeFoldersInput) {
  const next = new Set(expandedFolders);
  if (allVisibleExpanded) {
    visibleFolderPaths.forEach((path) => next.delete(path));
  } else {
    visibleFolderPaths.forEach((path) => next.add(path));
  }
  return next;
}

export function toggleFileTreeFolder(
  expandedFolders: Set<string>,
  path: string
) {
  const next = new Set(expandedFolders);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

export function ensureFileTreeParentFolderExpanded(
  expandedFolders: Set<string>,
  parentFolder: string
) {
  if (!parentFolder || expandedFolders.has(parentFolder)) {
    return expandedFolders;
  }

  const next = new Set(expandedFolders);
  next.add(parentFolder);
  return next;
}

export function getFileTreeInlineNewInputConfig(
  type: FileTreeInlineNewInputType
): FileTreeInlineNewInputConfig {
  if (type === 'file') {
    return {
      fallbackName: 'untitled',
      iconPath: 'untitled',
      isFolder: false,
    };
  }

  return {
    fallbackName: '\u65b0\u5efa\u6587\u4ef6\u5939',
    iconPath: 'folder',
    isFolder: true,
  };
}

export function buildNewFileTreeItemRelativePath(
  parentFolder: string,
  rawName: string,
  fallbackName: string
) {
  const name = rawName.trim() || fallbackName;
  return parentFolder ? `${parentFolder}/${name}` : name;
}

export function buildFileTreeDeleteConfirmation(
  relativePath: string,
  isFolder: boolean
) {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    title: '删除',
    message: isFolder
      ? `确定要删除文件夹“${name}”吗？`
      : `确定要删除文件“${name}”吗？`,
    confirmText: '删除',
    cancelText: '取消',
    variant: 'destructive' as const,
  };
}

export function getFileTreeRelativeClipboardText(relativePath: string) {
  return relativePath || '.';
}

export function getFileTreeAbsoluteClipboardText(
  relativePath: string,
  absolutePath: string,
  workspacePath: string
) {
  return relativePath ? absolutePath : workspacePath;
}

export function deriveFileTreeGitStatusMap(
  gitStatusFiles: FileTreeGitStatusEntry[] | undefined
) {
  const map = new Map<string, string>();
  if (!gitStatusFiles) {
    return map;
  }

  for (const entry of gitStatusFiles) {
    map.set(entry.path, entry.status);
  }
  return map;
}

export function deriveFileTreeEntries({
  files,
  directories,
  ignoredFiles,
  ignoredDirectories,
  lazyFiles,
  lazyDirectories,
  lazyGitignoredFiles,
  lazyGitignoredDirectories,
  lazyLoadableDirectories,
  lazyLoadAllDirectories,
}: DeriveFileTreeEntriesInput): DerivedFileTreeEntries {
  const mergedFiles = new Set<string>(files);
  lazyFiles.forEach((path) => mergedFiles.add(path));

  const mergedDirectories = new Set<string>(directories);
  lazyDirectories.forEach((path) => mergedDirectories.add(path));

  const mergedGitignoredFiles = new Set<string>(ignoredFiles);
  lazyGitignoredFiles.forEach((path) => mergedGitignoredFiles.add(path));

  const mergedGitignoredDirectories = new Set<string>(ignoredDirectories);
  lazyGitignoredDirectories.forEach((path) =>
    mergedGitignoredDirectories.add(path)
  );

  const effectiveLazyLoadableDirectories = new Set<string>();
  mergedDirectories.forEach((path) => {
    if (lazyLoadAllDirectories || isSpecialDirectoryPath(path)) {
      effectiveLazyLoadableDirectories.add(path);
    }
  });
  lazyLoadableDirectories.forEach((path) =>
    effectiveLazyLoadableDirectories.add(path)
  );

  return {
    mergedFiles: Array.from(mergedFiles),
    mergedDirectories: Array.from(mergedDirectories),
    mergedGitignoredFiles,
    mergedGitignoredDirectories,
    effectiveLazyLoadableDirectories,
  };
}

export function deriveFolderGitStatusMap(
  nodes: FileTreeNode[],
  gitStatusMap: Map<string, string>
) {
  const folderGitStatusMap = new Map<string, string>();

  const computeForNode = (node: FileTreeNode): string | null => {
    if (node.type === 'file') {
      return gitStatusMap.get(node.path) ?? null;
    }

    let highest: string | null = null;
    let highestPriority = -1;
    for (const child of node.children) {
      const childStatus = computeForNode(child);
      const childPriority = childStatus
        ? (GIT_STATUS_PRIORITY[childStatus] ?? -1)
        : -1;
      if (childStatus && childPriority > highestPriority) {
        highest = childStatus;
        highestPriority = childPriority;
      }
    }

    if (highest) {
      folderGitStatusMap.set(node.path, highest);
    }
    return highest;
  };

  nodes.forEach((node) => computeForNode(node));
  return folderGitStatusMap;
}

export function isSpecialDirectoryPath(path: string) {
  const leaf = path.split('/').filter(Boolean).pop() ?? '';
  if (!leaf) {
    return false;
  }
  return (
    SPECIAL_DEPENDENCY_DIRECTORIES.has(leaf) ||
    SPECIAL_BUILD_ARTIFACT_DIRECTORIES.has(leaf) ||
    leaf.startsWith('cmake-build-')
  );
}

export function buildTree(
  files: string[],
  directories: string[],
  lazyLoadableDirectories: Set<string>
): { nodes: FileTreeNode[]; folderPaths: Set<string> } {
  const root = new Map<string, FileTreeBuildNode>();
  const addNode = (
    map: Map<string, FileTreeBuildNode>,
    name: string,
    path: string,
    type: 'file' | 'folder',
    isLazyLoadable = false
  ) => {
    const existing = map.get(name);
    if (existing) {
      if (type === 'folder') {
        existing.type = 'folder';
      }
      if (isLazyLoadable) {
        existing.isLazyLoadable = true;
      }
      return existing;
    }
    const node: FileTreeBuildNode = {
      name,
      path,
      type,
      children: new Map(),
      isLazyLoadable,
    };
    map.set(name, node);
    return node;
  };

  const insertPath = (path: string, leafType: 'file' | 'folder') => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) {
      return;
    }
    let currentMap = root;
    let currentPath = '';
    parts.forEach((segment, index) => {
      const isLeaf = index === parts.length - 1;
      const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
      const nodeType: 'file' | 'folder' = isLeaf ? leafType : 'folder';
      const node = addNode(
        currentMap,
        segment,
        nextPath,
        nodeType,
        nodeType === 'folder' && lazyLoadableDirectories.has(nextPath)
      );
      if (nodeType === 'folder') {
        currentMap = node.children;
        currentPath = nextPath;
      }
    });
  };

  directories.forEach((path) => insertPath(path, 'folder'));
  files.forEach((path) => insertPath(path, 'file'));

  const folderPaths = new Set<string>();

  const sortNodes = (a: FileTreeBuildNode, b: FileTreeBuildNode) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  };

  const collapseFolderChain = (
    start: FileTreeBuildNode
  ): { node: FileTreeBuildNode; label: string; path: string } => {
    let node = start;
    const labels = [start.name];
    let path = start.path;

    let canCollapse = true;
    while (canCollapse) {
      const children = Array.from(node.children.values());
      const hasDirectFile = children.some((child) => child.type === 'file');
      const directFolders = children.filter((child) => child.type === 'folder');
      const hasLazyLoadableChild = directFolders.some(
        (child) => child.isLazyLoadable
      );
      if (
        node.isLazyLoadable ||
        hasDirectFile ||
        hasLazyLoadableChild ||
        directFolders.length !== 1
      ) {
        canCollapse = false;
        continue;
      }
      const next = directFolders[0];
      labels.push(next.name);
      node = next;
      path = node.path;
    }

    return {
      node,
      label: labels.join('.'),
      path,
    };
  };

  const toArray = (map: Map<string, FileTreeBuildNode>): FileTreeNode[] => {
    const nodes = Array.from(map.values())
      .sort(sortNodes)
      .map((node) => {
        if (node.type === 'folder') {
          const collapsed = collapseFolderChain(node);
          folderPaths.add(collapsed.path);
          return {
            name: collapsed.label,
            path: collapsed.path,
            type: 'folder' as const,
            children: toArray(collapsed.node.children),
            isLazyLoadable: collapsed.node.isLazyLoadable,
          };
        }
        return {
          name: node.name,
          path: node.path,
          type: 'file' as const,
          children: [],
        };
      });
    return nodes;
  };

  return { nodes: toArray(root), folderPaths };
}

export function isImagePath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return imageExtensions.has(ext);
}

export function resolveWorkspaceRootLabel(
  workspacePath: string,
  workspaceName?: string
) {
  const fromName = workspaceName?.trim();
  if (fromName) {
    return fromName;
  }
  const normalizedPath = workspacePath.replace(/[\\/]+$/, '');
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || normalizedPath || 'workspace';
}
