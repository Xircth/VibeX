import type { FileTreeNode, FileTreeBuildNode } from './file-tree-types';
import {
  SPECIAL_DEPENDENCY_DIRECTORIES,
  SPECIAL_BUILD_ARTIFACT_DIRECTORIES,
  imageExtensions,
} from './file-tree-constants';

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
