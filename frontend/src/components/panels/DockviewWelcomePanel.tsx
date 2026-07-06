import type { IDockviewPanelProps } from 'dockview-react';
import {
  FileSearch,
  FolderOpen,
  GitCompare,
  Search,
  Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

const welcomeActions = [
  {
    labelKey: 'welcomePanel.actionFilesLabel',
    descriptionKey: 'welcomePanel.actionFilesDescription',
    icon: FolderOpen,
    action: 'files',
  },
  {
    labelKey: 'welcomePanel.actionSearchLabel',
    descriptionKey: 'welcomePanel.actionSearchDescription',
    icon: Search,
    action: 'search',
  },
  {
    labelKey: 'welcomePanel.actionDiffsLabel',
    descriptionKey: 'welcomePanel.actionDiffsDescription',
    icon: GitCompare,
    action: 'diffs',
  },
  {
    labelKey: 'welcomePanel.actionTerminalLabel',
    descriptionKey: 'welcomePanel.actionTerminalDescription',
    icon: Terminal,
    action: 'terminal',
  },
] as const;

function DockviewWelcomePanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'common']);
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
          <h2 id="welcome-title">{t('welcomePanel.title')}</h2>
          <p className="workspace-welcome__copy">{t('welcomePanel.copy')}</p>
          <div
            className="workspace-welcome__actions"
            aria-label={t('welcomePanel.actionsAriaLabel')}
          >
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
                      {t(item.labelKey)}
                    </span>
                    <span className="workspace-welcome__action-description">
                      {t(item.descriptionKey)}
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
