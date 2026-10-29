import { Bell, Copy, ListTree, Plus, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { resolveWorkflowAgentId } from '../workflowAgent';
import { StudioAgentIcon } from './StudioAgentIcon';
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
    addStep,
    agentOptions,
    config,
    copySelected,
    definition,
    removeStep,
    setLogStepId,
  } = studio;

  if (!contextMenu) return null;

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
        {contextMenu.kind === 'pane' ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Plus className="size-4" /> {t('studio.addNode')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={() => {
                  addStep('agent');
                  setContextMenu(null);
                }}
              >
                <StudioAgentIcon
                  agentId={resolveWorkflowAgentId(
                    agentOptions,
                    config?.executor_profile?.executor
                  )}
                  agentOptions={agentOptions}
                  className="size-4"
                />
                {t('studio.agentStep')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  addStep('notify');
                  setContextMenu(null);
                }}
              >
                <Bell className="size-4" /> {t('studio.notify')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <>
            {contextMenu.confirmation ? null : (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    if (contextMenu.stepId) copySelected(contextMenu.stepId);
                    setContextMenu(null);
                  }}
                >
                  <Copy className="size-4" /> {t('studio.copyNode')}
                </DropdownMenuItem>
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
              </>
            )}
            <DropdownMenuItem
              onSelect={() => {
                if (contextMenu.stepId) setLogStepId(contextMenu.stepId);
                setContextMenu(null);
              }}
            >
              <ListTree className="size-4" /> {t('studio.showRecords')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
