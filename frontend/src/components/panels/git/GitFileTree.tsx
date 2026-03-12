import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import type { GitFileStatusEntry } from 'shared/types';
import { GitFileRow, type FileSection } from './GitFileRow';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: GitFileStatusEntry[];
}

function buildTree(files: GitFileStatusEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    parts.pop(); // remove file name, keep only directory parts
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          files: [],
        });
      }
      current = current.children.get(part)!;
    }

    current.files.push({ ...file, path: file.path });
  }

  return root;
}

function flattenSingleChildDirs(node: TreeNode): TreeNode {
  const result: TreeNode = { ...node, children: new Map() };

  for (const [key, child] of node.children) {
    let collapsed = child;
    let collapsedName = child.name;

    while (collapsed.children.size === 1 && collapsed.files.length === 0) {
      const [, nextChild] = collapsed.children.entries().next().value!;
      collapsedName = `${collapsedName}/${nextChild.name}`;
      collapsed = nextChild;
    }

    const flatChild = flattenSingleChildDirs(collapsed);
    flatChild.name = collapsedName;
    result.children.set(key, flatChild);
  }

  return result;
}

interface GitFileTreeProps {
  files: GitFileStatusEntry[];
  section: FileSection;
  selectedPath: string | null;
  selectedPaths?: Set<string>;
  onSelectFile: (path: string, e?: React.MouseEvent) => void;
  onDoubleClick?: (path: string) => void;
  onContextMenu?: (path: string, e: React.MouseEvent) => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
}

export const GitFileTree = memo(function GitFileTree({
  files,
  section,
  selectedPath,
  selectedPaths,
  onSelectFile,
  onDoubleClick,
  onContextMenu,
  onStageFile,
  onUnstageFile,
  onRevertFile,
}: GitFileTreeProps) {
  const tree = useMemo(() => flattenSingleChildDirs(buildTree(files)), [files]);

  return (
    <div className="flex flex-col">
      <TreeNodeRenderer
        node={tree}
        depth={0}
        section={section}
        selectedPath={selectedPath}
        selectedPaths={selectedPaths}
        onSelectFile={onSelectFile}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onRevertFile={onRevertFile}
        isRoot
      />
    </div>
  );
});

interface TreeNodeRendererProps {
  node: TreeNode;
  depth: number;
  section: FileSection;
  selectedPath: string | null;
  selectedPaths?: Set<string>;
  onSelectFile: (path: string, e?: React.MouseEvent) => void;
  onDoubleClick?: (path: string) => void;
  onContextMenu?: (path: string, e: React.MouseEvent) => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  isRoot?: boolean;
}

function TreeNodeRenderer({
  node,
  depth,
  section,
  selectedPath,
  selectedPaths,
  onSelectFile,
  onDoubleClick,
  onContextMenu,
  onStageFile,
  onUnstageFile,
  onRevertFile,
  isRoot = false,
}: TreeNodeRendererProps) {
  const [expanded, setExpanded] = useState(true);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const sortedDirs = useMemo(() => {
    return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [node.children]);

  const sortedFiles = useMemo(() => {
    return [...node.files].sort((a, b) => {
      const aName = a.path.split('/').pop() ?? a.path;
      const bName = b.path.split('/').pop() ?? b.path;
      return aName.localeCompare(bName);
    });
  }, [node.files]);

  const fileCount = useMemo(() => {
    function count(n: TreeNode): number {
      let total = n.files.length;
      for (const child of n.children.values()) {
        total += count(child);
      }
      return total;
    }
    return count(node);
  }, [node]);

  return (
    <>
      {!isRoot && (
        <div
          className="group flex items-center gap-1 px-2 py-[3px] cursor-pointer text-xs hover:bg-accent/30 text-muted-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={toggle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="h-3 w-3 shrink-0 text-yellow-500/70" />
          ) : (
            <Folder className="h-3 w-3 shrink-0 text-yellow-500/70" />
          )}
          <span className="truncate font-mono">{node.name}</span>
          <span className="text-muted-foreground/50 text-[10px]">({fileCount})</span>
        </div>
      )}

      {(isRoot || expanded) && (
        <>
          {sortedDirs.map((child) => (
            <TreeNodeRenderer
              key={child.path}
              node={child}
              depth={isRoot ? 0 : depth + 1}
              section={section}
              selectedPath={selectedPath}
              selectedPaths={selectedPaths}
              onSelectFile={onSelectFile}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              onStageFile={onStageFile}
              onUnstageFile={onUnstageFile}
              onRevertFile={onRevertFile}
            />
          ))}
          {sortedFiles.map((file) => (
            <div key={file.path} style={{ paddingLeft: `${(isRoot ? 0 : depth + 1) * 12}px` }}>
              <GitFileRow
                file={file}
                section={section}
                isActive={selectedPath === file.path}
                isSelected={selectedPaths?.has(file.path)}
                onSelect={onSelectFile}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
                onStageFile={onStageFile}
                onUnstageFile={onUnstageFile}
                onRevertFile={onRevertFile}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
}
