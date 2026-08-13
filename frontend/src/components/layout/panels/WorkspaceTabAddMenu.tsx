import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { useEffect } from 'react';
import {
  FileDiff,
  Globe2,
  Plus,
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
import { isEditorGroup } from '@/utils/dockviewGroupPolicy';

function NativeSurfaceOcclusionBridge({
  setOccluded,
}: {
  setOccluded: (occluded: boolean) => void;
}) {
  useEffect(() => {
    const occlusionFrame = requestAnimationFrame(() => setOccluded(true));

    return () => {
      cancelAnimationFrame(occlusionFrame);
      setOccluded(false);
    };
  }, [setOccluded]);

  return null;
}

export function WorkspaceTabAddMenu({
  api,
  group,
}: IDockviewHeaderActionsProps) {
  const { t } = useTranslation('panels');
  const { openDiffPreview, openNotes, openWebPreview, showTerminal } =
    usePanelActionsContext();
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();

  if (!isEditorGroup(group)) return null;

  const runInThisGroup = (action: () => void) => {
    api.setActive();
    action();
  };

  return (
    <DropdownMenu modal={false}>
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
        <NativeSurfaceOcclusionBridge setOccluded={setTabCreationMenuOpen} />
        <DropdownMenuItem
          onSelect={() => runInThisGroup(() => openWebPreview())}
        >
          <Globe2 />
          {t('tabCreation.browser')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runInThisGroup(openDiffPreview)}>
          <FileDiff />
          {t('tabCreation.review')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runInThisGroup(openNotes)}>
          <StickyNote />
          {t('tabCreation.note')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runInThisGroup(showTerminal)}>
          <SquareTerminal />
          {t('tabCreation.terminal')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
