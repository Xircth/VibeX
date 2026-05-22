export type ShortcutScope = '全局' | '工作区' | '编辑器';

export interface ImplementedShortcut {
  id: string;
  name: string;
  keys: string[];
  scope: ShortcutScope;
  description: string;
}

export const IMPLEMENTED_SHORTCUTS: readonly ImplementedShortcut[] = [
  {
    id: 'markdown-preview-toggle',
    name: 'Markdown 预览/编辑切换',
    keys: ['鼠标中键'],
    scope: '编辑器',
    description: '在 Markdown 文件预览标签页中切换渲染预览与源码编辑。',
  },
  {
    id: 'open-terminal',
    name: '打开终端栏',
    keys: ['Ctrl + `', 'Cmd + `'],
    scope: '工作区',
    description: '打开或聚焦当前工作区的终端面板。',
  },
  {
    id: 'toggle-file-tree',
    name: '打开左侧文件管理器',
    keys: ['Ctrl + P', 'Cmd + P'],
    scope: '工作区',
    description: '切换左侧文件管理器面板。',
  },
  {
    id: 'open-workspace-search',
    name: '打开全局搜索',
    keys: ['Ctrl + Shift + F', 'Cmd + Shift + F'],
    scope: '工作区',
    description: '打开或聚焦工作区搜索面板。',
  },
  {
    id: 'open-settings',
    name: '打开设置',
    keys: ['Ctrl + ,', 'Cmd + ,'],
    scope: '全局',
    description: '打开设置窗口。',
  },
  {
    id: 'save-file',
    name: '保存文件',
    keys: ['Ctrl + S', 'Cmd + S'],
    scope: '编辑器',
    description: '在文件编辑器中保存当前文件。',
  },
] as const;
