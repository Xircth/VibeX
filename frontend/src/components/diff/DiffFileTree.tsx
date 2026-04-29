import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, File } from 'lucide-react';

interface DiffFile {
  id: string;
  path: string;
  badge: { label: string; color: string };
  additions: number | null | undefined;
  deletions: number | null | undefined;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Record<string, TreeNode>;
  file?: DiffFile;
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: {} };
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        node.children[part] = {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          children: {},
        };
      }
      node = node.children[part];
      if (i === parts.length - 1) {
        node.file = { ...file, path: normalizedPath };
      }
    }
  }
  return root;
}

function countFiles(node: TreeNode): number {
  if (node.file) return 1;
  return Object.values(node.children).reduce(
    (sum, child) => sum + countFiles(child),
    0
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  onFileClick: (id: string) => void;
  activeFileId?: string | null;
}

function TreeNodeView({
  node,
  depth,
  onFileClick,
  activeFileId,
}: TreeNodeViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const children = Object.values(node.children);
  const isDir = !node.file && children.length > 0;
  const indent = depth * 14;

  if (node.file) {
    const hasStats = node.file.additions != null || node.file.deletions != null;
    const isActive = node.file.id === activeFileId;
    return (
      <button
        onClick={() => onFileClick(node.file!.id)}
        className={`group flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-[3px] text-left transition-colors ${
          isActive
            ? 'border-primary/40 bg-accent/60'
            : 'border-transparent hover:bg-accent/50'
        }`}
        style={{ paddingLeft: `${10 + indent}px` }}
      >
        <span
          className={`text-[10px] font-semibold w-4 text-center leading-none shrink-0 rounded-sm ${node.file.badge.color}`}
        >
          {node.file.badge.label}
        </span>
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
          {node.name}
        </span>
        {hasStats && (
          <span className="text-[10px] shrink-0 font-mono opacity-70 group-hover:opacity-100">
            {(node.file.additions ?? 0) > 0 && (
              <span className="text-green-600">+{node.file.additions}</span>
            )}
            {(node.file.deletions ?? 0) > 0 && (
              <span className="text-red-600 ml-0.5">
                -{node.file.deletions}
              </span>
            )}
          </span>
        )}
      </button>
    );
  }

  if (isDir) {
    const fileCount = countFiles(node);
    return (
      <div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-[3px] text-left transition-colors hover:bg-accent/30"
          style={{ paddingLeft: `${10 + indent}px` }}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {node.name}
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
            {fileCount}
          </span>
        </button>
        {!collapsed &&
          children.map((child) => (
            <TreeNodeView
              key={child.name}
              node={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              activeFileId={activeFileId}
            />
          ))}
      </div>
    );
  }

  return null;
}

interface DiffFileTreeProps {
  files: DiffFile[];
  onFileClick: (id: string) => void;
  activeFileId?: string | null;
}

export function DiffFileTree({
  files,
  onFileClick,
  activeFileId,
}: DiffFileTreeProps) {
  const root = buildTree(files);
  const children = Object.values(root.children);

  return (
    <div className="flex flex-col">
      {children.map((child) => (
        <TreeNodeView
          key={child.name}
          node={child}
          depth={0}
          onFileClick={onFileClick}
          activeFileId={activeFileId}
        />
      ))}
    </div>
  );
}
