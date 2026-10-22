import { useTranslation } from 'react-i18next';
import {
  Terminal,
  ClipboardList,
  List,
  GitCompareArrows,
  StickyNote,
  Puzzle,
} from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function RightPanelSidebar() {
  const { t } = useTranslation(['panels', 'common']);
  const {
    openNewTerminal,
    openDiffPreview,
    openNotes,
    openOrFocusPanel,
    openPluginPanel,
  } = usePanelActionsContext();
  const railSections = usePluginHostContributions('app_rail_section');

  const buttons = [
    {
      icon: Terminal,
      label: t('rightPanelSidebar.openTerminal'),
      onClick: openNewTerminal,
    },
    {
      icon: ClipboardList,
      label: t('rightPanelSidebar.sessionDetails'),
      onClick: () =>
        openOrFocusPanel(
          PANEL_IDS.SESSION_DETAILS,
          t('rightPanelSidebar.sessionDetails')
        ),
    },
    {
      icon: List,
      label: t('rightPanelSidebar.processes'),
      onClick: () =>
        openOrFocusPanel(PANEL_IDS.PROCESSES, t('rightPanelSidebar.processes')),
    },
    {
      icon: GitCompareArrows,
      label: t('rightPanelSidebar.gitDiff'),
      onClick: openDiffPreview,
    },
    {
      icon: StickyNote,
      label: t('rightPanelSidebar.notes'),
      onClick: openNotes,
    },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="workspace-chrome workspace-divider-left relative flex w-9 shrink-0 flex-col items-center gap-0.5 pt-2">
        {buttons.map((button) => {
          const Icon = button.icon;
          return (
            <Tooltip key={button.label}>
              <TooltipTrigger asChild>
                <button
                  onClick={button.onClick}
                  className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
                  aria-label={button.label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{button.label}</TooltipContent>
            </Tooltip>
          );
        })}

        <div className="my-1 h-px w-5 bg-border" />

        {railSections.map((item) => {
          const metadata = contributionMetadata(item);
          const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
          const Icon = contributionIconComponent(icon, Puzzle);
          const opens =
            metadata.opens &&
            typeof metadata.opens === 'object' &&
            !Array.isArray(metadata.opens)
              ? (metadata.opens as {
                  kind?: string;
                  id?: string;
                  instance?: string;
                })
              : null;
          const contributionId =
            typeof opens?.id === 'string' ? opens.id : item.id;
          return (
            <Tooltip key={`${item.pluginId}:${item.id}`}>
              <TooltipTrigger asChild>
                <button
                  onClick={() =>
                    openPluginPanel({
                      title: item.label,
                      pluginId: item.pluginId,
                      contributionId,
                      icon,
                      multiInstance: true,
                      instance: opens?.instance === 'new' ? 'new' : 'focus',
                    })
                  }
                  className="workspace-side-rail-button flex h-7 w-7 items-center justify-center"
                  aria-label={item.label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
