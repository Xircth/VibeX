import type { FileTreeNode } from './file-tree-types';

export function formatFileTreeStructure(nodes: FileTreeNode[]): string {
  const lines: string[] = [];

  const walk = (node: FileTreeNode, prefix: string) => {
    const label = node.type === 'folder' ? `${node.name}/` : node.name;
    lines.push(`${prefix}${label}`);
    if (node.type === 'folder') {
      node.children.forEach((child) => walk(child, `${prefix}  `));
    }
  };

  nodes.forEach((node) => walk(node, ''));
  return lines.join('\n');
}
