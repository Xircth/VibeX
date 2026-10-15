import type { IDockviewHeaderActionsProps } from 'dockview-react';
import {
  FileDiff,
  Plus,
  Puzzle,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { useOptionalWorktree } from '@/contexts/WorktreeContext';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  getDefaultTerminalShell,
  getTerminalShellOptions,
  getTerminalWorkspaceKey,
} from '@/lib/terminalPreferences';
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';
import { terminalHostPlatform } from '@/utils/platform';
import { openWorkspaceTerminal } from './openWorkspaceTerminal';

export function WorkspaceTabAddMenu({
  api,
  group,
}: IDockviewHeaderActionsProps) {
  const { t } = useTranslation('panels');
  const {
    openDiffPreview,
    openNotes,
    openTerminalEditorTab,
    openPluginPanel,
    runInEditorGroup,
  } = usePanelActionsContext();
  const pluginPanels = usePluginHostContributions('app_panel');
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();
  const system = useOptionalUserSystem();
  const worktree = useOptionalWorktree();
  const hostPlatform = terminalHostPlatform(system?.environment?.os_type);
  const shells = getTerminalShellOptions(hostPlatform);
  const defaultShell = getDefaultTerminalShell(
    system?.config,
    system?.environment?.os_type
  );

  if (!isEditorGroup(group)) return null;

  const runInThisGroup = (action: () => void) => {
    runInEditorGroup(group.id, () => {
      api.setActive();
      action();
    });
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
        <DropdownMenuItem onSelect={() => runInThisGroup(openDiffPreview)}>
          <FileDiff />
          {t('tabCreation.review')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runInThisGroup(openNotes)}>
          <StickyNote />
          {t('tabCreation.note')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SquareTerminal />
            {t('tabCreation.terminal')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="workspace-tab-add-menu min-w-[9rem]">
            {shells.map((shell) => (
              <DropdownMenuItem
                key={shell.value}
                onSelect={() =>
                  runInThisGroup(() =>
                    openWorkspaceTerminal({
                      shell: shell.value,
                      defaultShell,
                      workspaceId: getTerminalWorkspaceKey(
                        worktree?.activeWorktreeId ?? null
                      ),
                      openInEditor: openTerminalEditorTab,
                      onExternalError: (error) => {
                        toast.error(t('terminalHeader.openExternalFailed'), {
                          description:
                            error instanceof Error
                              ? error.message
                              : t('terminalHeader.confirmWarpInstalled'),
                        });
                      },
                    })
                  )
                }
              >
                {shell.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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
                    title: item.label,
                    pluginId: item.pluginId,
                    contributionId: item.id,
                    icon,
                    multiInstance: metadata.multiInstance === true,
                    instance: metadata.multiInstance === true ? 'new' : 'focus',
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
