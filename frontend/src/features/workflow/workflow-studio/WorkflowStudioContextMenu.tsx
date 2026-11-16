import { ListTree, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { WorkflowStudioView } from './useWorkflowStudio';

export function WorkflowStudioContextMenu({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    contextMenu,
    setContextMenu,
    t,
    definition,
    onDefinitionChange,
    removeStep,
    setLogStepId,
  } = studio;

  if (!contextMenu || contextMenu.kind === 'pane') return null;

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) setContextMenu(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          className="pointer-events-none fixed size-0"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuItem
          onSelect={() => {
            if (contextMenu.stepId) setLogStepId(contextMenu.stepId);
            setContextMenu(null);
          }}
        >
          <ListTree className="size-4" /> {t('studio.showRecords')}
        </DropdownMenuItem>
        {onDefinitionChange && !contextMenu.confirmation ? (
          <DropdownMenuItem
            className="text-destructive"
            disabled={definition.steps.length === 1}
            onSelect={() => {
              if (contextMenu.stepId) removeStep(contextMenu.stepId);
              setContextMenu(null);
            }}
          >
            <Trash2 className="size-4" /> {t('studio.deleteNode')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
