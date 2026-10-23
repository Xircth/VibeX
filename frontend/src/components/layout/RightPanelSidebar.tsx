import { usePanels, useSlotContributions } from '@vibex/plugin-sdk';
import { useMemo } from 'react';
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
import { Slot } from '@/components/plugins/Slot';

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
  const sdkRailSlots = useSlotContributions('rail.sections');
  const sdkPanels = usePanels();

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

  const pluginRailItems = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{
      key: string;
      label: string;
      icon: ReturnType<typeof contributionIconComponent>;
      onClick: () => void;
    }> = [];

    for (const slotItem of sdkRailSlots) {
      if (slotItem.component || slotItem.render) continue;
      const pluginId = slotItem.pluginId ?? 'plugin';
      const rawId = slotItem.id.startsWith(`${pluginId}:`)
        ? slotItem.id.slice(pluginId.length + 1)
        : slotItem.id;
      const key = `${pluginId}:${rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = slotItem.label ?? slotItem.tooltip ?? rawId;
      const iconName = slotItem.icon ?? null;
      const opens =
        slotItem.metadata?.opens &&
        typeof slotItem.metadata.opens === 'object' &&
        !Array.isArray(slotItem.metadata.opens)
          ? (slotItem.metadata.opens as { id?: string; instance?: string })
          : null;
      const contributionId = typeof opens?.id === 'string' ? opens.id : rawId;
      items.push({
        key,
        label,
        icon: contributionIconComponent(iconName, Puzzle),
        onClick: () => {
          if (slotItem.onActivate) {
            void Promise.resolve(slotItem.onActivate()).catch(() => undefined);
            return;
          }
          openPluginPanel({
            title: label,
            pluginId,
            contributionId,
            icon: iconName,
            multiInstance: true,
            instance: opens?.instance === 'new' ? 'new' : 'focus',
          });
        },
      });
    }

    for (const panel of sdkPanels) {
      if (panel.builtin || panel.zone === 'left') continue;
      const pluginId = panel.pluginId ?? 'plugin';
      const rawId = panel.id.startsWith(`${pluginId}:`)
        ? panel.id.slice(pluginId.length + 1)
        : panel.id;
      const key = `${pluginId}:${rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const iconName = panel.icon ?? null;
      items.push({
        key,
        label: panel.title,
        icon: contributionIconComponent(iconName, Puzzle),
        onClick: () =>
          openPluginPanel({
            title: panel.title,
            pluginId,
            contributionId: rawId,
            icon: iconName,
            multiInstance: panel.multiInstance !== false,
            instance: 'focus',
          }),
      });
    }

    for (const item of railSections) {
      const metadata = contributionMetadata(item);
      const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
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
      const contributionId = typeof opens?.id === 'string' ? opens.id : item.id;
      const key = `${item.pluginId}:${item.id}`;
      if (seen.has(key) || seen.has(`${item.pluginId}:${contributionId}`)) {
        continue;
      }
      seen.add(key);
      items.push({
        key,
        label: item.label,
        icon: contributionIconComponent(icon, Puzzle),
        onClick: () =>
          openPluginPanel({
            title: item.label,
            pluginId: item.pluginId,
            contributionId,
            icon,
            multiInstance: true,
            instance: opens?.instance === 'new' ? 'new' : 'focus',
          }),
      });
    }

    return items;
  }, [openPluginPanel, railSections, sdkPanels, sdkRailSlots]);

  const hasCustomRailComponents = useMemo(
    () => sdkRailSlots.some((item) => Boolean(item.component || item.render)),
    [sdkRailSlots]
  );

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

        {hasCustomRailComponents ? <Slot name="rail.sections" /> : null}

        {pluginRailItems.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <button
                  onClick={item.onClick}
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
