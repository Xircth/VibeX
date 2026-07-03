import type { IDockviewPanelProps } from 'dockview-react';
import {
  FileSearch,
  FolderOpen,
  GitCompare,
  Search,
  Terminal,
} from 'lucide-react';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

const welcomeActions = [
  {
    label: '浏览文件',
    description: '从左侧文件树打开源码或文档。',
    icon: FolderOpen,
    action: 'files',
  },
  {
    label: '搜索项目',
    description: '按关键字定位实现、配置和说明。',
    icon: Search,
    action: 'search',
  },
  {
    label: '查看差异',
    description: '检查工作区当前改动。',
    icon: GitCompare,
    action: 'diffs',
  },
  {
    label: '打开终端',
    description: '在当前工作目录运行命令。',
    icon: Terminal,
    action: 'terminal',
  },
] as const;

function DockviewWelcomePanel(_props: IDockviewPanelProps) {
  const { openOrFocusPanel, openDiffPreview, openNewTerminal } =
    usePanelActionsContext();

  const handleAction = (action: (typeof welcomeActions)[number]['action']) => {
    if (action === 'files') {
      openOrFocusPanel(PANEL_IDS.FILE_TREE, 'Files');
      return;
    }
    if (action === 'search') {
      openOrFocusPanel(PANEL_IDS.SEARCH, 'Search');
      return;
    }
    if (action === 'diffs') {
      openDiffPreview();
      return;
    }
    openNewTerminal();
  };

  return (
    <div
      className="workspace-welcome h-full w-full overflow-auto"
      data-panel="welcome"
    >
      <div className="workspace-welcome__inner">
        <section
          className="workspace-welcome__intro"
          aria-labelledby="welcome-title"
        >
          <div className="workspace-welcome__mark" aria-hidden="true">
            <FileSearch className="h-5 w-5" />
          </div>
          <p className="workspace-welcome__eyebrow">Workspace ready</p>
          <h2 id="welcome-title">从这里接手代码。</h2>
          <p className="workspace-welcome__copy">
            选择一个入口开始阅读、搜索、审查或运行命令。编辑区会保留你打开的上下文。
          </p>
          <div className="workspace-welcome__actions" aria-label="工作区入口">
            {welcomeActions.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.action}
                  type="button"
                  className="workspace-welcome__action"
                  onClick={() => handleAction(item.action)}
                >
                  <span className="workspace-welcome__action-icon">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="workspace-welcome__action-title">
                      {item.label}
                    </span>
                    <span className="workspace-welcome__action-description">
                      {item.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="workspace-welcome__artifact" aria-hidden="true">
          <div className="workspace-welcome__artifact-header">
            <span>worktree snapshot</span>
            <span>HEAD</span>
          </div>
          <div className="workspace-welcome__artifact-body">
            <div className="workspace-welcome__line is-add">
              <span>+</span>
              <code>compose new task context</code>
            </div>
            <div className="workspace-welcome__line">
              <span>•</span>
              <code>inspect changed files</code>
            </div>
            <div className="workspace-welcome__line is-run">
              <span>$</span>
              <code>pnpm run check</code>
            </div>
            <div className="workspace-welcome__line is-note">
              <span>→</span>
              <code>send findings to agent</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default DockviewWelcomePanel;
