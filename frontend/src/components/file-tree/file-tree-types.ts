export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children: FileTreeNode[];
  isLazyLoadable?: boolean;
};

export type FileOpenLocation = {
  line: number;
  column: number;
  endLine?: number;
};

export type FileTreeBuildNode = {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children: Map<string, FileTreeBuildNode>;
  isLazyLoadable: boolean;
};
