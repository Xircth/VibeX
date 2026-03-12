import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

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
    const parts = file.path.split('/');
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
        node.file = file;
      }
    }
  }
  return root;
}

function countFiles(node: TreeNode): number {
  if (node.file) return 1;
  return Object.values(node.children).reduce((sum, child) => sum + countFiles(child), 0);
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  onFileClick: (id: string) => void;
}

function TreeNodeView({ node, depth, onFileClick }: TreeNodeViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const children = Object.values(node.children);
  const isDir = !node.file && children.length > 0;
  const indent = depth * 12;

  if (node.file) {
    return (
      <button
        onClick={() => onFileClick(node.file!.id)}
        className="w-full flex items-center gap-1.5 px-2 py-0.5 text-left hover:bg-accent/50 rounded-sm"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        <span className={`text-[10px] font-medium px-0.5 rounded shrink-0 ${node.file.badge.color}`}>
          {node.file.badge.label}
        </span>
        <span className="text-xs truncate text-foreground flex-1">{node.name}</span>
        {(node.file.additions != null || node.file.deletions != null) && (
          <span className="text-[10px] shrink-0">
            <span className="text-green-600">+{node.file.additions ?? 0}</span>
            <span className="text-red-600 ml-0.5">-{node.file.deletions ?? 0}</span>
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
          className="w-full flex items-center gap-1 px-2 py-0.5 text-left hover:bg-accent/30 rounded-sm"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          }
          <span className="text-xs font-medium text-muted-foreground flex-1 truncate">{node.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0 bg-muted rounded px-1">{fileCount}</span>
        </button>
        {!collapsed && children.map((child) => (
          <TreeNodeView
            key={child.name}
            node={child}
            depth={depth + 1}
            onFileClick={onFileClick}
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
}

export function DiffFileTree({ files, onFileClick }: DiffFileTreeProps) {
  const root = buildTree(files);
  const children = Object.values(root.children);

  return (
    <div className="flex flex-col gap-0">
      {children.map((child) => (
        <TreeNodeView
          key={child.name}
          node={child}
          depth={0}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}
