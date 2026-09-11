import type { IDockviewHeaderActionsProps } from 'dockview-react';
import {
  FileDiff,
  Globe2,
  Plus,
  Puzzle,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';

export function WorkspaceTabAddMenu({
  api,
  group,
}: IDockviewHeaderActionsProps) {
  const { t } = useTranslation('panels');
  const {
    openDiffPreview,
    openNotes,
    openWebPreview,
    openTerminalEditorTab,
    openPluginPanel,
  } = usePanelActionsContext();
  const pluginPanels = usePluginHostContributions('app_panel');
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();
  const transport = useBackendTransport();
  const { supports } = useBackendCapabilities();
  const canOpenWebPreview =
    transport.environment === 'desktop' || supports('desktop.tauri');

  if (!isEditorGroup(group)) return null;

  const runInThisGroup = (action: () => void) => {
    api.setActive();
    action();
  };

  return (
    <DropdownMenu modal={false} onOpenChange={setTabCreationMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="workspace-tab-add-button"
          aria-label={t('tabCreation.newTab')}
          title={t('tabCreation.newTab')}
        >
          <Plus aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="workspace-tab-add-menu w-44"
      >
        {canOpenWebPreview ? (
          <DropdownMenuItem
            onSelect={() => runInThisGroup(() => openWebPreview())}
          >
            <Globe2 />
            {t('tabCreation.browser')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => runInThisGroup(openDiffPreview)}>
          <FileDiff />
          {t('tabCreation.review')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runInThisGroup(openNotes)}>
          <StickyNote />
          {t('tabCreation.note')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => runInThisGroup(openTerminalEditorTab)}
        >
          <SquareTerminal />
          {t('tabCreation.terminal')}
        </DropdownMenuItem>
        {pluginPanels.map((item) => {
          const metadata = contributionMetadata(item);
          const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
          const Icon = contributionIconComponent(icon, Puzzle);
          return (
            <DropdownMenuItem
              key={`${item.pluginId}:${item.id}`}
              onSelect={() =>
                runInThisGroup(() =>
                  openPluginPanel({
                    panelId: pluginSurfaceId(item.pluginId, item.id),
                    title: item.label,
                    pluginId: item.pluginId,
                    contributionId: item.id,
                    icon,
                  })
                )
              }
            >
              <Icon />
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
